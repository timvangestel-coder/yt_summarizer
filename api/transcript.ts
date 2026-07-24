/**
 * YouTube Transcript — Hybride aanpak (PoC)
 *
 * Haalt ondertiteling op van publieke YouTube-video's zonder dat
 * de video-eigenaar hoeft te zijn. Combineert twee methodes:
 *
 * 1. **YouTube Data API v3 (OAuth 2.0)** — captions.list voor taaldetectie
 *    (werkt vanuit elke omgeving via googleapis.com)
 * 2. **youtube-transcript package** — daadwerkelijke download via
 *    www.youtube.com (web-infrastructuur, geen IP-blokkade verwacht)
 * 3. **Fallback** — captions.download voor eigen video's (via OAuth)
 *
 * Codeerstijl: zelfde als mtgnews (Node.js https module, regex-based parsing)
 *
 * @module
 */

import * as https from 'node:https';
import { YoutubeTranscript } from 'youtube-transcript';

// ── Types ───────────────────────────────────────────────────────────

export interface TranscriptSnippet {
  text: string;
  start: number;
  duration: number;
}

export interface CaptionTrack {
  id: string;
  languageCode: string;
  name: string;
  kind?: string | undefined;
}

export interface TranscriptResult {
  videoId: string;
  title: string;
  language: string;
  snippets: TranscriptSnippet[];
  fullText: string;
  approach: string;
}

// ── Error classes (zelfde stijl als RssError in mtgnews) ────────────

export class TranscriptError extends Error {
  statusCode: number;
  videoId: string;

  constructor(message: string, statusCode: number, videoId: string) {
    super(message);
    this.name = 'TranscriptError';
    this.statusCode = statusCode;
    this.videoId = videoId;
  }
}

export class InvalidVideoIdError extends TranscriptError {
  constructor(videoId: string) {
    super('Ongeldige YouTube-URL. Geef een geldige openbare YouTube-video-URL op.', 400, videoId);
    this.name = 'InvalidVideoIdError';
  }
}

export class TranscriptNotAvailableError extends TranscriptError {
  constructor(videoId: string) {
    super('Deze video heeft geen beschikbare ondertiteling.', 404, videoId);
    this.name = 'TranscriptNotAvailableError';
  }
}

export class TranscriptDisabledError extends TranscriptError {
  constructor(videoId: string) {
    super('Ondertiteling is uitgeschakeld voor deze video.', 404, videoId);
    this.name = 'TranscriptDisabledError';
  }
}

export class OAuthError extends TranscriptError {
  constructor(videoId: string, detail: string) {
    super(`OAuth-authenticatiefout: ${detail}. Controleer de YouTube API-credentials.`, 502, videoId);
    this.name = 'OAuthError';
  }
}

export class QuotaExceededError extends TranscriptError {
  constructor(videoId: string) {
    super('Het YouTube API-quotum is overschreden. Probeer het later opnieuw.', 429, videoId);
    this.name = 'QuotaExceededError';
  }
}

// ── HTTPS helpers ───────────────────────────────────────────────────

/**
 * Voer een HTTPS GET-request uit met optionele headers.
 * Volgt redirects (max 5).
 */
function httpsGet(url: string, headers?: Record<string, string>): Promise<string> {
  const maxRedirects = 5;
  let redirectCount = 0;

  const doRequest = (currentUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(currentUrl);
      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'CloudAI-POC/1.0',
          ...headers,
        },
      };

      const req = https.request(options, (res) => {
        const { statusCode, headers: respHeaders } = res;
        const location = respHeaders['location'] as string | undefined;

        // Volg redirect (max 5)
        if (statusCode && statusCode >= 300 && statusCode < 400 && location && redirectCount < maxRedirects) {
          redirectCount++;
          const redirectUrl = new URL(location, currentUrl).href;
          resolve(doRequest(redirectUrl));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (statusCode && statusCode >= 400) {
            reject(new Error(`HTTP ${statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          resolve(body);
        });
      });

      req.on('error', (err) => reject(new Error(`Netwerkfout: ${err.message}`)));
      req.end();
    });
  };

  return doRequest(url);
}

/**
 * Voer een HTTPS POST-request uit met JSON-body en retourneer de geparsde JSON-response.
 */
function httpsPostJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const jsonBody = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(jsonBody),
        'User-Agent': 'CloudAI-POC/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const { statusCode } = res;
        if (statusCode && statusCode >= 400) {
          reject(new Error(`HTTP ${statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Ongeldige JSON-response (HTTP ${statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Netwerkfout: ${err.message}`)));
    req.write(jsonBody);
    req.end();
  });
}

// ── YouTube URL parsing ────────────────────────────────────────────

/**
 * Parse een YouTube-URL en retourneer de video ID, of null bij ongeldige URL.
 * Ondersteunt alle standaard YouTube-URL-formaten.
 */
export function parseVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})(?:[&?/]|$)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ── OAuth 2.0 token management ─────────────────────────────────────

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/**
 * Ververs een OAuth 2.0 access token met een refresh token.
 * POST naar https://oauth2.googleapis.com/token met grant_type=refresh_token.
 *
 * @param clientId - OAuth 2.0 Client ID
 * @param clientSecret - OAuth 2.0 Client Secret
 * @param refreshToken - OAuth 2.0 Refresh Token
 * @returns Access token string
 * @throws OAuthError bij ongeldige credentials
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  return new Promise((resolve, reject) => {
    const urlObj = new URL('https://oauth2.googleapis.com/token');
    const bodyStr = body.toString();
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const { statusCode } = res;

        if (statusCode === 400) {
          let detail = 'Ongeldige refresh token of client credentials';
          try {
            const errResp = JSON.parse(raw);
            if (errResp.error_description) detail = errResp.error_description;
          } catch { /* ignore parse errors */ }
          reject(new OAuthError('', detail));
          return;
        }

        if (statusCode && statusCode >= 400) {
          reject(new OAuthError('', `HTTP ${statusCode} van OAuth-endpoint`));
          return;
        }

        try {
          const data: AccessTokenResponse = JSON.parse(raw);
          if (!data.access_token) {
            reject(new OAuthError('', 'Geen access_token in OAuth-response'));
            return;
          }
          resolve(data.access_token);
        } catch {
          reject(new OAuthError('', 'Ongeldige JSON van OAuth-endpoint'));
        }
      });
    });

    req.on('error', (err) => reject(new OAuthError('', `Netwerkfout: ${err.message}`)));
    req.write(bodyStr);
    req.end();
  });
}

// ── YouTube Data API v3 helpers ────────────────────────────────────

/**
 * Haal beschikbare caption tracks op voor een video via captions.list.
 *
 * @param videoId - YouTube video ID
 * @param accessToken - Geldig OAuth 2.0 access token
 * @returns Array van CaptionTrack objecten
 * @throws TranscriptNotAvailableError bij geen tracks
 * @throws OAuthError bij authenticatiefout
 * @throws QuotaExceededError bij quota overschrijding
 */
export async function fetchCaptionTracks(videoId: string, accessToken: string): Promise<CaptionTrack[]> {
  const url = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`;

  let body: string;
  try {
    body = await httpsGet(url, {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    if (message.includes('HTTP 401') || message.includes('HTTP 403')) {
      throw new OAuthError(videoId, 'Toegang geweigerd. Mogelijk ongeldig token of onvoldoende rechten.');
    }
    if (message.includes('HTTP 429')) {
      throw new QuotaExceededError(videoId);
    }
    throw new TranscriptError(`Fout bij ophalen caption tracks: ${message}`, 502, videoId);
  }

  let data: { items?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(body);
  } catch {
    throw new TranscriptError('Ongeldige response van YouTube API', 502, videoId);
  }

  if (!data.items || data.items.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  const tracks: CaptionTrack[] = data.items.map((item) => {
    const snippet = (item.snippet ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? ''),
      languageCode: String(snippet.language ?? ''),
      name: String(snippet.name ?? ''),
      kind: snippet.trackKind as string | undefined,
    };
  });

  return tracks;
}

/**
 * Download een caption track in SubViewer-formaat via captions.download.
 *
 * @param captionId - Caption track ID
 * @param accessToken - Geldig OAuth 2.0 access token
 * @returns SBV-content als string
 * @throws OAuthError bij authenticatiefout
 * @deprecated Alleen voor eigen video's. Gebruik fetchTranscriptViaPackage voor publieke video's.
 */
export async function downloadCaption(captionId: string, accessToken: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(captionId)}?tfmt=sbv`;

  try {
    return await httpsGet(url, {
      'Authorization': `Bearer ${accessToken}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    if (message.includes('HTTP 401') || message.includes('HTTP 403')) {
      throw new OAuthError('', 'Toegang geweigerd bij downloaden ondertiteling.');
    }
    if (message.includes('HTTP 404')) {
      throw new TranscriptError('Ondertiteling niet gevonden (caption track ID ongeldig).', 404, '');
    }
    throw new TranscriptError(`Fout bij downloaden ondertiteling: ${message}`, 502, '');
  }
}

/**
 * Download een transcript via de youtube-transcript package.
 *
 * Werkt voor alle publieke YouTube-video's zonder dat de gebruiker
 * video-eigenaar hoeft te zijn. Maakt gebruik van de www.youtube.com
 * web-infrastructuur (niet googleapis.com), waardoor IP-blokkades
 * vanuit cloud-omgevingen onwaarschijnlijker zijn.
 *
 * @param videoId - YouTube video ID
 * @param lang - Optionele taalcode (bv. 'nl', 'en'). Eerste beschikbare taal bij leeg.
 * @returns Array van TranscriptSnippet objecten
 * @throws TranscriptNotAvailableError bij geen beschikbaar transcript
 * @throws TranscriptDisabledError als ondertiteling is uitgeschakeld
 * @throws QuotaExceededError bij te veel requests
 */
export async function fetchTranscriptViaPackage(
  videoId: string,
  lang?: string,
): Promise<TranscriptSnippet[]> {
  try {
    const config = lang ? { lang } : undefined;
    const segments = await YoutubeTranscript.fetchTranscript(videoId, config);
    if (!segments || segments.length === 0) {
      throw new TranscriptNotAvailableError(videoId);
    }
    return segments.map((s) => ({
      text: s.text,
      start: s.offset / 1000, // milliseconden → seconden
      duration: s.duration / 1000,
    }));
  } catch (err) {
    // Vertaal youtube-transcript errors naar onze error classes
    if (err instanceof TranscriptError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('disabled') || msg.includes('Transcript is disabled')) {
      throw new TranscriptDisabledError(videoId);
    }
    if (msg.toLowerCase().includes('not available') || msg.includes('No transcripts')) {
      throw new TranscriptNotAvailableError(videoId);
    }
    if (msg.toLowerCase().includes('too many request') || msg.toLowerCase().includes('captcha')) {
      throw new QuotaExceededError(videoId);
    }
    throw new TranscriptError(`Fout bij ophalen transcript: ${msg}`, 502, videoId);
  }
}

// ── SBV parsing ────────────────────────────────────────────────────

/**
 * Parse SubViewer (SBV) formatted captions naar getimede snippets.
 *
 * SBV-formaat:
 * ```
 * 0:00:00.000,0:00:01.540
 * Hey there
 *
 * 0:00:02.000,0:00:04.500
 * How are you?
 * ```
 */
export function parseSbv(sbvContent: string): TranscriptSnippet[] {
  const snippets: TranscriptSnippet[] = [];

  // Split op lege regels (dubbele newline)
  const blocks = sbvContent.trim().split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    const timeLine = lines[0].trim();
    const textLines = lines.slice(1).map(l => l.trim()).filter(l => l.length > 0);
    if (textLines.length === 0) continue;

    // Parse tijdsregel: 0:00:00.000,0:00:01.540
    const timeMatch = timeLine.match(/^(\d+):(\d{2}):(\d{2})\.(\d{3}),(\d+):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!timeMatch) continue;

    const start =
      parseInt(timeMatch[1]) * 3600 +
      parseInt(timeMatch[2]) * 60 +
      parseInt(timeMatch[3]) +
      parseInt(timeMatch[4]) / 1000;
    const end =
      parseInt(timeMatch[5]) * 3600 +
      parseInt(timeMatch[6]) * 60 +
      parseInt(timeMatch[7]) +
      parseInt(timeMatch[8]) / 1000;
    const duration = end - start;

    snippets.push({
      text: decodeHtmlEntities(textLines.join(' ')),
      start,
      duration: Math.max(0, duration),
    });
  }

  return snippets;
}

/**
 * Decodeer HTML-entiteiten in een tekst.
 */
function decodeHtmlEntities(text: string): string {
  // Eerst alle andere entities decoderen, dan pas &amp; (anders zou &amp;quot; → quot; → " worden)
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&');
}

// ── Taalkeuze ──────────────────────────────────────────────────────

/**
 * Kies de beste caption track: NL > EN > eerste.
 */
function pickBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const nl = tracks.find((t) => t.languageCode === 'nl');
  if (nl) return nl;
  const en = tracks.find((t) => t.languageCode === 'en');
  if (en) return en;
  return tracks[0];
}

// ── Hoofdfunctie ───────────────────────────────────────────────────

/**
 * Haal het transcript van een YouTube-video op via de hybride aanpak.
 *
 * Doorloopt de volgende flow:
 * 1. Valideer video ID
 * 2. (Optioneel) captions.list via OAuth voor taaldetectie
 * 3. youtube-transcript package voor daadwerkelijke download (publieke video's)
 * 4. Fallback naar captions.download via OAuth (alleen voor eigen video's)
 *
 * @param videoId - YouTube video ID
 * @param clientId - OAuth 2.0 Client ID (optioneel, alleen voor taaldetectie/fallback)
 * @param clientSecret - OAuth 2.0 Client Secret
 * @param refreshToken - OAuth 2.0 Refresh Token
 * @returns TranscriptResult
 * @throws TranscriptError bij fouten
 */
export async function getTranscriptYoutubeApi(
  videoId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TranscriptResult> {
  // Stap 1: Valideer video ID
  if (!parseVideoId(videoId)) {
    throw new InvalidVideoIdError(videoId);
  }

  // Stap 2: Optionele taaldetectie via OAuth (captions.list)
  let selectedLanguage: string | undefined;
  let tracks: CaptionTrack[] = [];
  let oauthAvailable = false;

  if (clientId && clientSecret && refreshToken) {
    try {
      const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
      tracks = await fetchCaptionTracks(videoId, accessToken);
      oauthAvailable = true;
      const best = pickBestCaptionTrack(tracks);
      if (best) selectedLanguage = best.languageCode;
    } catch (err) {
      // OAuth-fout is niet fataal — verder met standaard taal
      console.error(`[transcript] OAuth taaldetectie mislukt voor ${videoId}:`,
        err instanceof Error ? err.message : err);
    }
  }

  // Stap 3: Download transcript via youtube-transcript package (publieke video's)
  try {
    const snippets = await fetchTranscriptViaPackage(videoId, selectedLanguage);
    const fullText = snippets.map((s) => s.text).join(' ');

    return {
      videoId,
      title: `Video ${videoId}`,
      language: selectedLanguage || (snippets.length > 0 ? 'onbekend' : ''),
      snippets,
      fullText,
      approach: 'youtube-transcript',
    };
  } catch (packageErr) {
    // Stap 4: Fallback naar captions.download via OAuth (alleen eigen video's)
    if (oauthAvailable && tracks.length > 0) {
      console.error(`[transcript] Package download mislukt voor ${videoId}, probeer OAuth fallback:`,
        packageErr instanceof Error ? packageErr.message : packageErr);

      const selectedTrack = pickBestCaptionTrack(tracks);
      if (!selectedTrack) {
        throw packageErr; // Geen tracks beschikbaar
      }

      try {
        const token = await getAccessToken(clientId, clientSecret, refreshToken);
        const sbvContent = await downloadCaption(selectedTrack.id, token);
        const snippets = parseSbv(sbvContent);

        if (snippets.length === 0) {
          throw packageErr;
        }

        const fullText = snippets.map((s) => s.text).join(' ');
        return {
          videoId,
          title: `Video ${videoId}`,
          language: selectedTrack.languageCode,
          snippets,
          fullText,
          approach: 'youtube-data-api-v3',
        };
      } catch {
        // Fallback faalt ook, gooi originele fout
        throw packageErr;
      }
    }

    // Geen fallback beschikbaar
    throw packageErr;
  }
}

/**
 * Download een transcript via de proxy relay (Cloudflare Tunnel → thuis-PC → YouTube).
 *
 * Maakt een InnerTube-request naar de generieke reverse proxy. De proxy
 * routeert via een consumer ISP, waardoor YouTube geen datacenter-IP blokkeert.
 *
 * Twee-stappen proces:
 * 1. POST naar /youtubei/v1/player?prettyPrint=false om caption tracks op te halen
 * 2. GET naar captionTracks[n].baseUrl om de XML-ondertiteling te downloaden
 * 3. Parse XML naar TranscriptSnippet[]
 *
 * @param videoId - YouTube video ID
 * @param proxyUrl - Basis-URL van de proxy (bv. https://random.trycloudflare.com)
 * @param apiKey - API-key voor proxy-authenticatie
 * @param lang - Optionele taalcode (bv. 'nl', 'en')
 * @returns Array van TranscriptSnippet objecten
 * @throws TranscriptNotAvailableError bij geen beschikbaar transcript
 * @throws TranscriptError bij proxy- of netwerkfouten
 */
export async function fetchTranscriptViaProxy(
  videoId: string,
  proxyUrl: string,
  apiKey: string,
  lang?: string,
): Promise<TranscriptSnippet[]> {
  // Valideer video ID
  if (!parseVideoId(videoId)) {
    throw new InvalidVideoIdError(videoId);
  }

  const proxyBase = proxyUrl.replace(/\/+$/, '');
  console.log(`[transcript/proxy] Using proxy URL: ${proxyBase}`);
  const commonHeaders: Record<string, string> = {
    'x-api-key': apiKey,
    'x-forwarded-host': 'www.youtube.com',
  };

  // ── Stap 1: POST naar /youtubei/v1/player?prettyPrint=false ──────────
  const innerTubeBody = {
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
      },
    },
    videoId,
  };

  let playerResponse: Response;
  try {
    playerResponse = await fetch(`${proxyBase}/youtubei/v1/player?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...commonHeaders,
        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      },
      body: JSON.stringify(innerTubeBody),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new TranscriptError('Proxy request timeout (30s).', 504, videoId);
    }
    throw new TranscriptError(
      `Netwerkfout bij proxy-request: ${err instanceof Error ? err.message : String(err)}`,
      502,
      videoId,
    );
  }

  if (!playerResponse.ok) {
    const bodyText = await playerResponse.text().catch(() => '');
    if (playerResponse.status === 401) {
      throw new TranscriptError('Proxy authenticatiefout. Controleer de PROXY_API_KEY.', 502, videoId);
    }
    if (playerResponse.status === 403) {
      throw new TranscriptError(
        'Domein niet toegestaan in proxy whitelist. Controleer de proxy configuratie.',
        502,
        videoId,
      );
    }
    throw new TranscriptError(
      `Proxy fout (HTTP ${playerResponse.status}): ${bodyText.slice(0, 200)}`,
      502,
      videoId,
    );
  }

  // Parse player response om caption tracks te extraheren
  let playerData: Record<string, unknown>;
  try {
    playerData = (await playerResponse.json()) as Record<string, unknown>;
  } catch {
    throw new TranscriptError('Ongeldige JSON-response van YouTube player API.', 502, videoId);
  }

  // Debug: log response keys om te zien wat YouTube teruggeeft
  console.log(`[transcript/proxy] Player response keys: ${Object.keys(playerData).join(', ')}`);
  if (playerData.error) {
    const errInfo = playerData.error as Record<string, unknown>;
    console.log(`[transcript/proxy] YouTube API error: ${JSON.stringify(errInfo).slice(0, 300)}`);
  }
  console.log(`[transcript/proxy] Has captions: ${'captions' in playerData}`);

  // Navigeer: captions → playerCaptionsTracklistRenderer → captionTracks[]
  const captions = playerData.captions as Record<string, unknown> | undefined;
  if (captions) {
    console.log(`[transcript/proxy] captions keys: ${Object.keys(captions).join(', ')}`);
    const tlr = captions.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
    if (tlr) {
      console.log(`[transcript/proxy] tracklistRenderer keys: ${Object.keys(tlr).join(', ')}`);
      const ct = tlr.captionTracks as Array<unknown> | undefined;
      console.log(`[transcript/proxy] captionTracks: ${ct ? ct.length : 'undefined'}`);
      if (ct && ct.length > 0) {
        console.log(`[transcript/proxy] First track keys: ${Object.keys(ct[0] as Record<string, unknown>).join(', ')}`);
        console.log(`[transcript/proxy] First track languageCode: ${(ct[0] as Record<string, unknown>).languageCode}`);
      }
    } else {
      console.log(`[transcript/proxy] NO playerCaptionsTracklistRenderer in captions`);
    }
  }
  const captions = playerData.captions as Record<string, unknown> | undefined;
  if (!captions) {
    throw new TranscriptNotAvailableError(videoId);
  }
  const tracklistRenderer = captions.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  if (!tracklistRenderer) {
    throw new TranscriptNotAvailableError(videoId);
  }
  const captionTracks = tracklistRenderer.captionTracks as Array<Record<string, unknown>> | undefined;
  if (!captionTracks || captionTracks.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  // Kies de beste track: NL > opgegeven taal > EN > eerste
  let selectedTrack: Record<string, unknown> | undefined =
    captionTracks.find((t) => t.languageCode === 'nl');
  if (!selectedTrack && lang) {
    selectedTrack = captionTracks.find((t) => t.languageCode === lang);
  }
  if (!selectedTrack) {
    selectedTrack = captionTracks.find((t) => t.languageCode === 'en');
  }
  if (!selectedTrack) {
    selectedTrack = captionTracks[0];
  }

  const baseUrl = selectedTrack.baseUrl as string | undefined;
  if (!baseUrl) {
    throw new TranscriptError('Geen baseUrl in caption track.', 502, videoId);
  }

  // ── Stap 2: GET naar baseUrl via proxy ──────────────────────────────
  const baseUrlObj = new URL(baseUrl);
  const proxyPath = baseUrlObj.pathname + baseUrlObj.search;

  let transcriptResponse: Response;
  try {
    transcriptResponse = await fetch(`${proxyBase}${proxyPath}`, {
      method: 'GET',
      headers: {
        ...commonHeaders,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new TranscriptError('Proxy request timeout (30s) voor transcript download.', 504, videoId);
    }
    throw new TranscriptError(
      `Netwerkfout bij transcript download via proxy: ${err instanceof Error ? err.message : String(err)}`,
      502,
      videoId,
    );
  }

  if (!transcriptResponse.ok) {
    throw new TranscriptError(
      `Transcript download fout (HTTP ${transcriptResponse.status}).`,
      502,
      videoId,
    );
  }

  const xmlContent = await transcriptResponse.text();

  // ── Stap 3: Parse XML naar TranscriptSnippet[] ──────────────────────
  return parseTranscriptXml(xmlContent, videoId);
}

/**
 * Parse een YouTube transcript XML naar TranscriptSnippet[].
 *
 * Ondersteunt twee formaten:
 * - srv3: <p t="1200" d="2500">text</p> (t in milliseconden)
 * - classic: <text start="1.2" dur="2.5">text</text> (t in seconden)
 */
function parseTranscriptXml(xml: string, videoId: string): TranscriptSnippet[] {
  const snippets: TranscriptSnippet[] = [];

  // Probeer srv3-formaat: <p t="1200" d="2500">text</p>
  const srv3Regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([^<]*)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = srv3Regex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durationMs = parseInt(match[2], 10);
    const text = decodeHtmlEntities(match[3].trim());
    if (text) {
      snippets.push({
        text,
        start: startMs / 1000,
        duration: durationMs / 1000,
      });
    }
  }

  // Als geen srv3-matches, probeer classic-formaat: <text start="1.2" dur="2.5">text</text>
  if (snippets.length === 0) {
    const classicRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
    while ((match = classicRegex.exec(xml)) !== null) {
      const start = parseFloat(match[1]);
      const duration = parseFloat(match[2]);
      const text = decodeHtmlEntities(match[3].trim());
      if (text) {
        snippets.push({ text, start, duration });
      }
    }
  }

  if (snippets.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  return snippets;
}

/**
 * Formatteer een fout naar een gebruiksvriendelijk bericht met HTTP-statuscode.
 */
export function formatTranscriptError(err: unknown): { message: string; statusCode: number } {
  if (err instanceof TranscriptError) {
    return { message: err.message, statusCode: err.statusCode };
  }
  return { message: 'Er is een onbekende fout opgetreden.', statusCode: 500 };
}

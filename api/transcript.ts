/**
 * YouTube Data API v3 — Transcript ophalen via OAuth 2.0
 *
 * Vervangt de InnerTube-Android-aanpak die cloud-IP's blokkeert.
 * Gebruikt captions.list + captions.download via googleapis.com
 * met OAuth 2.0 token-verversing (refresh token flow).
 *
 * Codeerstijl: zelfde als mtgnews (Node.js https module, regex-based parsing)
 *
 * @module
 */

import * as https from 'node:https';

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
 * Haal het transcript van een YouTube-video op via de officiële YouTube Data API v3.
 * Doorloopt de volledige flow: token verversen → captions.list → captions.download → SBV parse.
 *
 * @param videoId - YouTube video ID
 * @param clientId - OAuth 2.0 Client ID
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

  // Stap 2: Verkrijg access token
  let accessToken: string;
  try {
    accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
  } catch (err) {
    if (err instanceof TranscriptError) throw err;
    throw new OAuthError(videoId, err instanceof Error ? err.message : 'Onbekende fout bij token-verversing');
  }

  // Stap 3: Haal caption tracks op
  const tracks = await fetchCaptionTracks(videoId, accessToken);

  // Stap 4: Kies beste taal
  const selectedTrack = pickBestCaptionTrack(tracks);
  if (!selectedTrack) {
    throw new TranscriptNotAvailableError(videoId);
  }

  // Stap 5: Download caption in SBV-formaat
  const sbvContent = await downloadCaption(selectedTrack.id, accessToken);

  // Stap 6: Parse SBV naar snippets
  const snippets = parseSbv(sbvContent);
  if (snippets.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
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

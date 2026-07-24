/**
 * YouTube Transcript — Proxy relay (PoC)
 *
 * Haalt ondertiteling op van publieke YouTube-video's via een
 * reverse proxy (Cloudflare Tunnel → thuis-PC → YouTube).
 *
 * Codeerstijl: zelfde als mtgnews (regex-based parsing)
 *
 * @module
 */

import { YoutubeTranscript } from 'youtube-transcript';

// ── Types ───────────────────────────────────────────────────────────

export interface TranscriptSnippet {
  text: string;
  start: number;
  duration: number;
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

export class QuotaExceededError extends TranscriptError {
  constructor(videoId: string) {
    super('Het YouTube API-quotum is overschreden. Probeer het later opnieuw.', 429, videoId);
    this.name = 'QuotaExceededError';
  }
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

// ── Proxy relay ────────────────────────────────────────────────────

/** Download een transcript via de proxy relay (Cloudflare Tunnel → thuis-PC → YouTube).
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

  // Navigeer: captions → playerCaptionsTracklistRenderer → captionTracks[]
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
 * Decodeer HTML-entiteiten in een tekst.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&');
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

  // Probeer srv3-formaat: <p t="1200" d="2500">text</p> of <p t="1200" d="2500"><s>text</s></p>
  const srv3Regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = srv3Regex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durationMs = parseInt(match[2], 10);
    const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '').trim());
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

/**
 * Vercel Serverless Function — YouTube transcript ophalen via InnerTube API.
 * Zelfde stijl als mtgnews rss-feed-fetcher.ts:
 * - Node.js `https`-module voor HTTP-requests (geen externe HTTP-client)
 * - Regex-based XML-parsing (geen externe XML-parser)
 * - Getypte foutafhandeling met error-klassen
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';

// ── Types ───────────────────────────────────────────────────────────

interface TranscriptSnippet {
  text: string;
  start: number;
  duration: number;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string;
}

interface TranscriptResult {
  videoId: string;
  title: string;
  language: string;
  snippets: TranscriptSnippet[];
  fullText: string;
}

// ── Error classes (zelfde stijl als RssError in mtgnews) ────────────

class TranscriptError extends Error {
  statusCode: number;
  videoId: string;

  constructor(message: string, statusCode: number, videoId: string) {
    super(message);
    this.name = 'TranscriptError';
    this.statusCode = statusCode;
    this.videoId = videoId;
  }
}

class InvalidVideoIdError extends TranscriptError {
  constructor(videoId: string) {
    super('Ongeldige YouTube-URL. Geef een geldige openbare YouTube-video-URL op.', 400, videoId);
    this.name = 'InvalidVideoIdError';
  }
}

class TranscriptNotAvailableError extends TranscriptError {
  constructor(videoId: string) {
    super('Deze video heeft geen beschikbare ondertiteling.', 404, videoId);
    this.name = 'TranscriptNotAvailableError';
  }
}

class TranscriptDisabledError extends TranscriptError {
  constructor(videoId: string) {
    super('Ondertiteling is uitgeschakeld voor deze video.', 404, videoId);
    this.name = 'TranscriptDisabledError';
  }
}

class IpBlockedError extends TranscriptError {
  constructor(videoId: string) {
    super(
      'YouTube blokkeert verzoeken vanuit de cloudomgeving. ' +
      'De InnerTube-Android-aanpak werkt niet vanaf Vercel. ' +
      'Er is geen alternatieve route binnen dit issue.',
      503,
      videoId,
    );
    this.name = 'IpBlockedError';
  }
}

class InnerTubeError extends TranscriptError {
  constructor(videoId: string, detail: string) {
    super(`Interne fout bij het ophalen van ondertiteling: ${detail}`, 502, videoId);
    this.name = 'InnerTubeError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Voer een HTTPS POST uit en retourneer de geparseerde JSON body. */
function httpsPostJson(url: string, body: unknown): Promise<unknown> {
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
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Ongeldige JSON-response van InnerTube (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Netwerkfout bij InnerTube-request: ${err.message}`)));
    req.write(jsonBody);
    req.end();
  });
}

/** Voer een HTTPS GET uit en retourneer de response als string. */
function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/xml, application/xml, */*',
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} bij ophalen timedtext XML`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });

    req.on('error', (err) => reject(new Error(`Netwerkfout bij timedtext-request: ${err.message}`)));
    req.end();
  });
}

/** Parse een YouTube-URL en extraheer de 11-char video ID. */
function parseVideoId(url: string): string | null {
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

/** Kies de beste caption track: NL > EN > eerste beschikbare. */
function pickBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;

  // Zoek Nederlands
  const nl = tracks.find((t) => t.languageCode === 'nl');
  if (nl) return nl;

  // Zoek Engels
  const en = tracks.find((t) => t.languageCode === 'en');
  if (en) return en;

  // Eerste beschikbare
  return tracks[0];
}

/** Decodeer HTML-entities in een string. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/** Parse timedtext-XML naar TranscriptSnippet[] (zelfde stijl als parseRssFeed in mtgnews). */
function parseTimedtextXml(xml: string): TranscriptSnippet[] {
  const snippets: TranscriptSnippet[] = [];

  // srv3-formaat: <p t="0" d="1540"><s>Hey there</s></p>
  const srv3Regex = /<p\s+t="([^"]*)"\s+d="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
  let srv3Match;
  let hasSrv3 = false;

  while ((srv3Match = srv3Regex.exec(xml)) !== null) {
    hasSrv3 = true;
    // Extract text from <s> tags inside <p>
    const innerText = srv3Match[3].replace(/<[^>]+>/g, '').trim();
    snippets.push({
      text: decodeHtmlEntities(innerText),
      start: parseFloat(srv3Match[1]) / 1000, // milliseconden → seconden
      duration: parseFloat(srv3Match[2]) / 1000,
    });
  }

  if (!hasSrv3) {
    // Ouder formaat: <text start="0.0" dur="1.54">Hey there</text>
    const textRegex = /<text start="([^"]+)" dur="([^"]*)">([^<]*)<\/text>/g;
    let match;
    while ((match = textRegex.exec(xml)) !== null) {
      snippets.push({
        text: decodeHtmlEntities(match[3]),
        start: parseFloat(match[1]),
        duration: match[2] ? parseFloat(match[2]) : 0,
      });
    }
  }

  return snippets;
}

/** Detecteer of de InnerTube-response een IP-blokkade aangeeft. */
function isIpBlocked(response: unknown): boolean {
  const resp = response as Record<string, unknown>;
  if (resp?.error && typeof resp.error === 'object') {
    const err = resp.error as Record<string, unknown>;
    const messages = [
      err?.message,
      ...(Array.isArray(err?.errors) ? (err.errors as Array<Record<string, unknown>>).map((e) => e?.message) : []),
    ].filter(Boolean).map(String);

    return messages.some(
      (m) =>
        m.includes('blocked') ||
        m.includes('IP') ||
        m.includes('robot') ||
        m.includes('automated'),
    );
  }
  return false;
}

/** Detecteer of ondertiteling is uitgeschakeld voor deze video. */
function isTranscriptDisabled(response: unknown): boolean {
  const resp = response as Record<string, unknown>;
  const playabilityStatus = resp?.playabilityStatus as Record<string, unknown> | undefined;
  if (playabilityStatus?.status === 'UNPLAYABLE' || playabilityStatus?.status === 'LOGIN_REQUIRED') {
    return true;
  }
  return false;
}

// ── Hoofdlogica ─────────────────────────────────────────────────────

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

async function getTranscript(videoId: string): Promise<TranscriptResult> {
  // Stap 1: POST naar InnerTube API om captionTracks te ontdekken
  const innerTubeBody = {
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
      },
    },
    videoId,
  };

  let response: unknown;
  try {
    response = await httpsPostJson(INNERTUBE_API_URL, innerTubeBody);
  } catch (err) {
    throw new InnerTubeError(videoId, err instanceof Error ? err.message : 'Onbekende fout bij InnerTube-request');
  }

  // Controleer op IP-blokkade
  if (isIpBlocked(response)) {
    throw new IpBlockedError(videoId);
  }

  // Controleer of video afspeelbaar is
  if (isTranscriptDisabled(response)) {
    throw new TranscriptDisabledError(videoId);
  }

  // Extraheer video metadata
  const resp = response as Record<string, unknown>;
  const videoDetails = resp?.videoDetails as Record<string, unknown> | undefined;
  const title: string = (videoDetails?.title as string) || 'Onbekende titel';

  // Extraheer caption tracks
  const captions = resp?.captions as Record<string, unknown> | undefined;
  const tracklistRenderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const captionTracksRaw = tracklistRenderer?.captionTracks as Array<Record<string, unknown>> | undefined;

  if (!captionTracksRaw || captionTracksRaw.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  // Map naar CaptionTrack interface
  const captionTracks: CaptionTrack[] = captionTracksRaw.map((track) => ({
    baseUrl: track.baseUrl as string,
    languageCode: track.languageCode as string,
    name: ((track.name as Record<string, unknown>)?.runs as Array<Record<string, unknown>>)?.[0]?.text as string || track.languageCode as string,
    kind: track.kind as string | undefined,
  }));

  // Stap 2: Kies beste taal
  const selectedTrack = pickBestCaptionTrack(captionTracks);
  if (!selectedTrack) {
    throw new TranscriptNotAvailableError(videoId);
  }

  // Stap 3: Fetch timedtext XML
  let xml: string;
  try {
    xml = await httpsGet(selectedTrack.baseUrl);
  } catch (err) {
    throw new InnerTubeError(videoId, err instanceof Error ? err.message : 'Fout bij ophalen timedtext XML');
  }

  // Stap 4: Parse XML naar snippets
  const snippets = parseTimedtextXml(xml);
  if (snippets.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  // Stap 5: Bouw fullText
  const fullText = snippets.map((s) => s.text).join(' ');

  return {
    videoId,
    title,
    language: selectedTrack.languageCode,
    snippets,
    fullText,
  };
}

// ── Vercel handler ──────────────────────────────────────────────────

/** Vercel entrypoint — Node.js (req, res) pattern. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Alleen POST toestaan
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Lees de request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let body: { url?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
    return;
  }

  if (!body.url || typeof body.url !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "url" field in JSON body.' }));
    return;
  }

  // Parse video ID uit URL
  const videoId = parseVideoId(body.url);
  if (!videoId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ongeldige YouTube-URL. Geef een geldige openbare YouTube-video-URL op.' }));
    return;
  }

  try {
    const result = await getTranscript(videoId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      videoId: result.videoId,
      title: result.title,
      language: result.language,
      snippetCount: result.snippets.length,
      fullTextLength: result.fullText.length,
      fullText: result.fullText,
      snippets: result.snippets,
    }));
  } catch (err) {
    if (err instanceof TranscriptError) {
      res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: err.message,
        errorType: err.name,
        videoId: err.videoId,
      }));
    } else {
      console.error('Unexpected error in transcript handler:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

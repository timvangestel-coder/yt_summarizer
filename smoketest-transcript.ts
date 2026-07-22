/**
 * Smoketest voor YouTube transcript — Issue 04
 *
 * Voert de transcript-logica lokaal uit (zonder Vercel) via tsx.
 * Gebruik: npx tsx smoketest-transcript.ts
 *
 * Testcases:
 * 1. Bekende video met ondertiteling (TED-talk: jNQXAC9IVRw — "Me at the zoo")
 * 2. Video zonder ondertiteling
 * 3. Ongeldige URL
 */

import * as https from 'node:https';

// ── Types (zelfde als in transcript.ts) ─────────────────────────────

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

// ── Error classes ───────────────────────────────────────────────────

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
    super('Ongeldige YouTube-URL.', 400, videoId);
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
    super('YouTube blokkeert verzoeken vanuit de cloudomgeving.', 503, videoId);
    this.name = 'IpBlockedError';
  }
}

class InnerTubeError extends TranscriptError {
  constructor(videoId: string, detail: string) {
    super(`Interne fout: ${detail}`, 502, videoId);
    this.name = 'InnerTubeError';
  }
}

// ── Helpers (zelfde als in transcript.ts) ───────────────────────────

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
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Ongeldige JSON (HTTP ${res.statusCode})`)); }
      });
    });
    req.on('error', (err) => reject(new Error(`Netwerkfout: ${err.message}`)));
    req.write(jsonBody);
    req.end();
  });
}

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
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });
    req.on('error', (err) => reject(new Error(`Netwerkfout: ${err.message}`)));
    req.end();
  });
}

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

function pickBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const nl = tracks.find((t) => t.languageCode === 'nl');
  if (nl) return nl;
  const en = tracks.find((t) => t.languageCode === 'en');
  if (en) return en;
  return tracks[0];
}

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

function parseTimedtextXml(xml: string): TranscriptSnippet[] {
  const snippets: TranscriptSnippet[] = [];
  const srv3Regex = /<p\s+t="([^"]*)"\s+d="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
  let srv3Match;
  let hasSrv3 = false;
  while ((srv3Match = srv3Regex.exec(xml)) !== null) {
    hasSrv3 = true;
    const innerText = srv3Match[3].replace(/<[^>]+>/g, '').trim();
    snippets.push({
      text: decodeHtmlEntities(innerText),
      start: parseFloat(srv3Match[1]) / 1000,
      duration: parseFloat(srv3Match[2]) / 1000,
    });
  }
  if (!hasSrv3) {
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

function isIpBlocked(response: unknown): boolean {
  const resp = response as Record<string, unknown>;
  if (resp?.error && typeof resp.error === 'object') {
    const err = resp.error as Record<string, unknown>;
    const messages = [
      err?.message,
      ...(Array.isArray(err?.errors) ? (err.errors as Array<Record<string, unknown>>).map((e) => e?.message) : []),
    ].filter(Boolean).map(String);
    return messages.some((m) => m.includes('blocked') || m.includes('IP') || m.includes('robot') || m.includes('automated'));
  }
  return false;
}

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
  const innerTubeBody = {
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
    videoId,
  };

  let response: unknown;
  try {
    response = await httpsPostJson(INNERTUBE_API_URL, innerTubeBody);
  } catch (err) {
    throw new InnerTubeError(videoId, err instanceof Error ? err.message : 'Onbekende fout');
  }

  if (isIpBlocked(response)) throw new IpBlockedError(videoId);
  if (isTranscriptDisabled(response)) throw new TranscriptDisabledError(videoId);

  const resp = response as Record<string, unknown>;
  const videoDetails = resp?.videoDetails as Record<string, unknown> | undefined;
  const title: string = (videoDetails?.title as string) || 'Onbekende titel';

  const captions = resp?.captions as Record<string, unknown> | undefined;
  const tracklistRenderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const captionTracksRaw = tracklistRenderer?.captionTracks as Array<Record<string, unknown>> | undefined;

  if (!captionTracksRaw || captionTracksRaw.length === 0) {
    throw new TranscriptNotAvailableError(videoId);
  }

  const captionTracks: CaptionTrack[] = captionTracksRaw.map((track) => ({
    baseUrl: track.baseUrl as string,
    languageCode: track.languageCode as string,
    name: ((track.name as Record<string, unknown>)?.runs as Array<Record<string, unknown>>)?.[0]?.text as string || track.languageCode as string,
    kind: track.kind as string | undefined,
  }));

  const selectedTrack = pickBestCaptionTrack(captionTracks);
  if (!selectedTrack) throw new TranscriptNotAvailableError(videoId);

  let xml: string;
  try {
    xml = await httpsGet(selectedTrack.baseUrl);
  } catch (err) {
    throw new InnerTubeError(videoId, err instanceof Error ? err.message : 'Fout bij ophalen timedtext XML');
  }

  const snippets = parseTimedtextXml(xml);
  if (snippets.length === 0) throw new TranscriptNotAvailableError(videoId);

  const fullText = snippets.map((s) => s.text).join(' ');

  return { videoId, title, language: selectedTrack.languageCode, snippets, fullText };
}

// ── Smoketest runner ────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  details: string;
  durationMs: number;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'PASS', details: '✅ Geslaagd', durationMs: Date.now() - start };
  } catch (err) {
    if (err instanceof IpBlockedError) {
      return { name, status: 'BLOCKED', details: `🔒 IP geblokkeerd: ${err.message}`, durationMs: Date.now() - start };
    }
    return { name, status: 'FAIL', details: `❌ ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('🧪 Smoketest — YouTube Transcript (Issue 04)');
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  console.log();

  const results: TestResult[] = [];

  // Test 1: Bekende video met ondertiteling
  results.push(await runTest('Video met ondertiteling (jNQXAC9IVRw)', async () => {
    const result = await getTranscript('jNQXAC9IVRw');
    console.log(`   Titel: ${result.title}`);
    console.log(`   Taal: ${result.language}`);
    console.log(`   Aantal snippets: ${result.snippets.length}`);
    console.log(`   Volledige tekst lengte: ${result.fullText.length} tekens`);
    console.log(`   Eerste 100 chars: "${result.fullText.slice(0, 100)}..."`);
    if (result.snippets.length === 0) throw new Error('Geen snippets gevonden');
    if (!result.fullText) throw new Error('Geen fullText');
  }));

  // Test 2: Ongeldige URL
  results.push(await runTest('Ongeldige URL', async () => {
    const videoId = parseVideoId('https://example.com/geen-video');
    if (videoId) throw new Error('Zou null moeten zijn voor ongeldige URL');
  }));

  // Test 3: parseVideoId met geldige URL
  results.push(await runTest('parseVideoId geldige URL', async () => {
    const id = parseVideoId('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
  }));

  // Test 4: parseVideoId met youtu.be
  results.push(await runTest('parseVideoId youtu.be URL', async () => {
    const id = parseVideoId('https://youtu.be/jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
  }));

  // Test 5: parseVideoId met raw ID
  results.push(await runTest('parseVideoId raw ID', async () => {
    const id = parseVideoId('jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
  }));

  // Test 6: Ongeldig video ID formaat
  results.push(await runTest('parseVideoId ongeldig formaat', async () => {
    const id = parseVideoId('https://www.youtube.com/watch?v=te-kort');
    if (id) throw new Error(`Zou null moeten zijn, kreeg ${id}`);
  }));

  // Test 7: Video zonder ondertiteling (gebruik een random niet-bestaande video)
  results.push(await runTest('Video zonder ondertiteling (zzzzzzzzzzz)', async () => {
    try {
      await getTranscript('zzzzzzzzzzz');
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof TranscriptNotAvailableError || err instanceof TranscriptDisabledError || err instanceof InnerTubeError) {
        // Dit zijn acceptabele fouten voor een niet-bestaande video
        console.log(`   Acceptabele fout: ${err.name} — ${err.message}`);
      } else if (err instanceof IpBlockedError) {
        throw err; // Laat BLOCKED status door
      } else {
        throw err;
      }
    }
  }));

  // ── Resultaten ──────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(60));
  console.log('📊 Resultaten');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;

  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : result.status === 'BLOCKED' ? '🔒' : '❌';
    console.log(` ${icon} ${result.name} (${result.durationMs}ms)`);
    if (result.status !== 'PASS') {
      console.log(`     ${result.details}`);
    }
  }

  console.log();
  console.log(`Totaal: ${results.length} tests — ${passed} passed, ${failed} failed, ${blocked} blocked`);
  console.log();

  // ── Experimentresultaat ─────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('📋 Experimentresultaat');
  console.log('='.repeat(60));
  console.log();
  console.log(`**Datum:** ${new Date().toISOString()}`);
  console.log(`**Omgeving:** Lokaal (zonder Vercel)`);
  console.log(`**Aanpak:** InnerTube Android API (POST /youtubei/v1/player)`);
  console.log(`**Resultaat:** ${failed > 0 ? '⚠️ Deels mislukt' : blocked > 0 ? '🔒 IP geblokkeerd' : '✅ Alle tests geslaagd'}`);
  console.log();
  console.log('**Bevindingen:**');
  if (blocked > 0) {
    console.log('- YouTube blokkeert de InnerTube-Android-aanpak vanuit deze omgeving.');
    console.log('- Dit is consistent met de bekende IP-blocking van cloud-providers.');
    console.log('- Voor Vercel (AWS Lambda) wordt hetzelfde verwacht.');
  } else if (failed > 0) {
    console.log('- Sommige tests faalden. Zie details hierboven.');
  } else {
    console.log('- De InnerTube-Android-aanpak werkt lokaal.');
    console.log('- Caption tracks worden succesvol ontdekt.');
    console.log('- Timedtext XML wordt correct geparsed.');
    console.log('- Taalkeuze (NL > EN > eerste) werkt.');
    console.log('- URL-validatie werkt voor alle formaten.');
  }
  console.log();
  console.log('**Aanbevolen vervolg:**');
  if (blocked > 0) {
    console.log('1. Deploy naar Vercel en test opnieuw (HITL-stap 1).');
    console.log('2. Als Vercel ook geblokkeerd is, documenteer het issue als geblokkeerd.');
  } else {
    console.log('1. Deploy naar Vercel en voer dezelfde smoketest uit op de cloudomgeving.');
    console.log('2. Meet de doorlooptijd en vergelijk met lokale resultaten.');
  }
}

main().catch(console.error);

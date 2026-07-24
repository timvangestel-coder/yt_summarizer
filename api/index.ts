/**
 * Vercel Serverless Function — Node.js (req, res) pattern.
 * Alle routes worden via rewrites in vercel.json naar deze functie gestuurd.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TranscriptError,
  TranscriptResult,
  TranscriptSnippet,
  getTranscriptYoutubeApi,
} from './transcript.js';

// ── Environment variables ───────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD;
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;
const OPENCODE_ENDPOINT = process.env.OPENCODE_ENDPOINT || 'https://opencode.ai/zen/v1/chat/completions';
const OPENCODE_MODEL_ID = process.env.OPENCODE_MODEL_ID || 'deepseek-v4-flash-free';
const LLM_TIMEOUT_SECONDS = Number(process.env.LLM_TIMEOUT) || 60;
const LLM_TIMEOUT_MS = LLM_TIMEOUT_SECONDS * 1000;
const TEST_PROMPT = process.env.TEST_PROMPT || 'Vat in één zin samen wat een REST API is.';
const MAX_RESULT_URL_LENGTH = 1500; // max chars voor result in query parameter
const TRANSCRIPT_VIDEO_ID = process.env.TRANSCRIPT_VIDEO_ID || 'RyQD8jQrenU';
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN || '';

// ── Logging helper ──────────────────────────────────────────────────
interface LogEntry {
  time: string;
  requestId: string;
  model: string;
  durationMs: number;
  outcome: 'success' | 'error';
  providerStatus?: number;
  responseLength?: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
  errorCategory?: string;
}
function logEntry(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

/** Parse Basic Auth credentials uit de Authorization header. */
function parseBasicAuth(headers: IncomingMessage['headers']): string | null {
  const auth = headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  if (!auth.startsWith('Basic ')) return null;
  try {
    const base64 = auth.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return null;
    return decoded.slice(colonIndex + 1);
  } catch {
    return null;
  }
}

/** Stuur een 401-response die de browser Basic Auth-dialog triggert. */
function requireAuth(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Cloud AI POC", charset="UTF-8"',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ error: 'Authorization required' }));
}

// ── DeepSeek API call ───────────────────────────────────────────────
interface DeepSeekResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number };
}
interface DeepSeekError {
  category: 'auth' | 'rate-limit' | 'timeout' | 'provider' | 'network' | 'config';
  message: string;
  status?: number;
}

async function callDeepSeek(prompt: string): Promise<DeepSeekResult> {
  if (!OPENCODE_API_KEY) {
    throw { category: 'config', message: 'OPENCODE_API_KEY is niet geconfigureerd.' } satisfies DeepSeekError;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(OPENCODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCODE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENCODE_MODEL_ID,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200000,
        stream: false,
      }),
      signal: controller.signal,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        throw { category: 'auth', message: 'Ongeldige API-sleutel. Controleer de OPENCODE_API_KEY.', status: 401 } satisfies DeepSeekError;
      }
      if (response.status === 429) {
        throw { category: 'rate-limit', message: 'Te veel verzoeken. Probeer het later opnieuw.', status: 429 } satisfies DeepSeekError;
      }
      throw { category: 'provider', message: `De AI-provider meldt een fout (HTTP ${response.status}). Probeer het later opnieuw.`, status: response.status } satisfies DeepSeekError;
    }

    const content: string | undefined = body?.choices?.[0]?.message?.content;
    if (!content) {
      throw { category: 'provider', message: 'Ongeldig antwoord van de AI-provider (geen content in response).', status: response.status } satisfies DeepSeekError;
    }

    return {
      content,
      tokenUsage: {
        prompt: body?.usage?.prompt_tokens ?? 0,
        completion: body?.usage?.completion_tokens ?? 0,
        total: body?.usage?.total_tokens ?? 0,
      },
    };
  } catch (err: unknown) {
    // Timeout van AbortController
    if (err && typeof err === 'object' && 'name' in err && (err as any).name === 'AbortError') {
      throw { category: 'timeout', message: `Het model reageerde niet binnen de time-out van ${LLM_TIMEOUT_SECONDS} seconden.` } satisfies DeepSeekError;
    }
    // Als het al een DeepSeekError is, gooi opnieuw
    if (err && typeof err === 'object' && 'category' in err) {
      throw err;
    }
    // Netwerkfout
    throw { category: 'network', message: 'Geen verbinding met de API. Controleer de endpoint-configuratie.' } satisfies DeepSeekError;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── YouTube Transcript (via YouTube Data API v3, geïmporteerd uit transcript.ts) ──

// ── HTML templates ──────────────────────────────────────────────────
const PAGE_STYLE = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #0f172a; color: #e2e8f0;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 2.5rem;
      max-width: 640px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p, li { color: #94a3b8; line-height: 1.6; }
    .badge {
      display: inline-block; margin-top: 1.5rem;
      background: #334155; padding: 0.4rem 0.8rem; border-radius: 6px;
      font-size: 0.8rem; color: #cbd5e1;
    }
    button {
      margin-top: 1.5rem; width: 100%; padding: 0.8rem; border: none;
      border-radius: 8px; background: #3b82f6; color: #fff;
      font-size: 1rem; cursor: pointer; transition: background 0.2s;
    }
    button:hover { background: #2563eb; }
    button:disabled { background: #475569; cursor: not-allowed; }
    .result { margin-top: 1.5rem; }
    .result-box {
      background: #0f172a; border-radius: 8px; padding: 1rem;
      margin-top: 0.5rem; white-space: pre-wrap; word-break: break-word;
      border-left: 4px solid #3b82f6; line-height: 1.6;
    }
    .error-box { border-left-color: #ef4444; }
    .meta {
      font-size: 0.8rem; color: #64748b; margin-top: 0.5rem;
    }
    .spinner {
      display: inline-block; width: 1rem; height: 1rem;
      border: 2px solid #64748b; border-top-color: #e2e8f0;
      border-radius: 50%; animation: spin 0.6s linear infinite;
      vertical-align: middle; margin-right: 0.4rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
`;

function renderFormPage(error?: string, result?: string, meta?: string): string {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Prompt — Cloud AI POC</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>🧪 Test de DeepSeek-koppeling</h1>
    <p>Deze pagina verstuurt een vaste testprompt naar <strong>DeepSeek V4 Flash Free</strong> via OpenCode Zen en toont het antwoord.</p>

    <form method="POST" action="/test-prompt" id="prompt-form">
      <button type="submit" id="submit-btn">Verstuur testprompt</button>
    </form>

    ${error ? `<div class="result"><p style="color:#ef4444;">❌ Fout</p><div class="result-box error-box">${escapeHtml(error)}</div></div>` : ''}
    ${result ? `<div class="result"><p style="color:#22c55e;">✅ Antwoord</p><div class="result-box">${escapeHtml(result)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>` : ''}

    <div class="badge">Protected by HTTP Basic Auth</div>
  </div>

  <script>
    document.getElementById('prompt-form')?.addEventListener('submit', function(e) {
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Bezig met verwerken...';
    });
  </script>
</body>
</html>`;
}

function renderTranscriptPage(error?: string, result?: TranscriptResult, durationMs?: number): string {
  const snippetsHtml = result?.snippets.map((s, i) =>
    `<tr>
      <td style="padding:0.25rem 0.5rem;color:#64748b;white-space:nowrap;font-size:0.85rem;">${s.start.toFixed(1)}s</td>
      <td style="padding:0.25rem 0.5rem;color:#e2e8f0;">${escapeHtml(s.text)}</td>
    </tr>`
  ).join('') || '';

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Transcript — Cloud AI POC</title>
  <style>${PAGE_STYLE}
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    tr:nth-child(even) { background: #0f172a; }
    .video-meta { font-size: 0.85rem; color: #94a3b8; margin-top: 0.5rem; }
    .fulltext-box { max-height: 300px; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="card" style="max-width: 800px;">
    <h1>🎬 YouTube Transcript</h1>
    <p>Haal de ondertiteling op van een bekende YouTube-video — werkt voor alle publieke video's zonder inloggen.</p>
    <form method="POST" action="/transcript" id="transcript-form">
      <button type="submit" id="submit-btn">📥 Haal transcript op van voorbeeldvideo</button>
    </form>

    ${error ? `<div class="result"><p style="color:#ef4444;">❌ Fout</p><div class="result-box error-box">${escapeHtml(error)}</div></div>` : ''}

    ${result ? `
    <div class="result">
      <p style="color:#22c55e;">✅ Transcript opgehaald</p>
      <div class="video-meta">
        <strong>Titel:</strong> ${escapeHtml(result.title)}<br>
        <strong>Video ID:</strong> ${result.videoId}<br>
        <strong>Taal:</strong> ${result.language}<br>
        <strong>Aantal snippets:</strong> ${result.snippets.length}<br>
        <strong>Doorlooptijd:</strong> ${durationMs}ms
      </div>
      <p style="margin-top:1rem;font-weight:600;">Volledige tekst</p>
      <div class="result-box fulltext-box">${escapeHtml(result.fullText)}</div>
      <p style="margin-top:1rem;font-weight:600;">Snippets (tijd + tekst)</p>
      <div class="result-box" style="padding:0;overflow-x:auto;">
        <table>
          <thead>
            <tr style="background:#1e293b;">
              <th style="padding:0.5rem;text-align:left;color:#94a3b8;font-size:0.85rem;">Tijd</th>
              <th style="padding:0.5rem;text-align:left;color:#94a3b8;font-size:0.85rem;">Tekst</th>
            </tr>
          </thead>
          <tbody>${snippetsHtml}</tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <div class="badge">Protected by HTTP Basic Auth</div>
    <p style="margin-top:1rem;text-align:center;"><a href="/" style="color:#3b82f6;">← Terug naar home</a></p>
  </div>

  <script>
    document.getElementById('transcript-form')?.addEventListener('submit', function(e) {
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Bezig met ophalen transcript...';
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Verwerk een inkomend verzoek. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';
  const pathname = url.split('?')[0]; // strip query params

  // --- Healthcheck (openbaar) ---
  if (method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // --- Alle andere routes vereisen authenticatie ---
  if (!APP_PASSWORD) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'APP_PASSWORD not configured' }));
    return;
  }

  const providedPassword = parseBasicAuth(req.headers);
  if (providedPassword !== APP_PASSWORD) {
    requireAuth(res);
    return;
  }

  // --- Test-prompt formulier (GET) ---
  if (method === 'GET' && pathname === '/test-prompt') {
    const parsedUrl = new URL(url, 'http://localhost');
    const errorParam = parsedUrl.searchParams.get('error') || undefined;
    const resultParam = parsedUrl.searchParams.get('result') || undefined;
    const metaParam = parsedUrl.searchParams.get('meta') || undefined;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderFormPage(errorParam, resultParam, metaParam));
    return;
  }

  // --- Test-prompt verwerken (POST) ---
  if (method === 'POST' && pathname === '/test-prompt') {
    const startTime = Date.now();
    const requestId = `req_${startTime}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Alleen de vaste testprompt gebruiken (zoals gespecificeerd in issue 03)
      const prompt = TEST_PROMPT;

      const result = await callDeepSeek(prompt);
      const durationMs = Date.now() - startTime;

      // Logging — alleen metadata
      logEntry({
        time: new Date().toISOString(),
        requestId,
        model: OPENCODE_MODEL_ID,
        durationMs,
        outcome: 'success',
        providerStatus: 200,
        responseLength: result.content.length,
        tokenUsage: result.tokenUsage,
      });

      const meta = `Model: ${OPENCODE_MODEL_ID} · Duur: ${durationMs}ms · Tokens: ${result.tokenUsage.total} (${result.tokenUsage.prompt} in / ${result.tokenUsage.completion} uit)`;
      let displayResult = result.content;
      if (displayResult.length > MAX_RESULT_URL_LENGTH) {
        displayResult = displayResult.slice(0, MAX_RESULT_URL_LENGTH) + '\n\n... (antwoord ingekort voor weergave)';
      }
      const encodedResult = encodeURIComponent(displayResult);
      const encodedMeta = encodeURIComponent(meta);
      res.writeHead(303, { Location: `/test-prompt?result=${encodedResult}&meta=${encodedMeta}` });
      res.end();
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const deepSeekErr = err as DeepSeekError;

      // Logging — alleen metadata
      logEntry({
        time: new Date().toISOString(),
        requestId,
        model: OPENCODE_MODEL_ID,
        durationMs,
        outcome: 'error',
        errorCategory: deepSeekErr.category,
        providerStatus: deepSeekErr.status,
      });

      const userMessage = deepSeekErr.message || 'Er is een onbekende fout opgetreden.';
      const encodedError = encodeURIComponent(userMessage);
      res.writeHead(303, { Location: `/test-prompt?error=${encodedError}` });
      res.end();
    }
    return;
  }

  // --- Transcript pagina (GET) ---
  if (method === 'GET' && pathname === '/transcript') {
    const parsedUrl = new URL(url, 'http://localhost');
    const errorParam = parsedUrl.searchParams.get('error') || undefined;
    const resultParam = parsedUrl.searchParams.get('result') || undefined;
    const metaParam = parsedUrl.searchParams.get('meta') || undefined;

    if (resultParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(resultParam));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderTranscriptPage(undefined, parsed, metaParam ? Number(metaParam) : undefined));
        return;
      } catch { /* fall through to empty form */ }
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTranscriptPage(errorParam));
    return;
  }

  // --- Transcript ophalen (POST) — YouTube Data API v3 ---
  if (method === 'POST' && pathname === '/transcript') {
    const startTime = Date.now();

    try {
      const result = await getTranscriptYoutubeApi(
        TRANSCRIPT_VIDEO_ID,
        YOUTUBE_CLIENT_ID || '',
        YOUTUBE_CLIENT_SECRET || '',
        YOUTUBE_REFRESH_TOKEN || '',
      );
      const durationMs = Date.now() - startTime;

      // Beperk fullText lengte voor URL parameter
      const resultForUrl = {
        ...result,
        fullText: result.fullText.length > MAX_RESULT_URL_LENGTH
          ? result.fullText.slice(0, MAX_RESULT_URL_LENGTH) + '\n\n... (tekst ingekort voor weergave)'
          : result.fullText,
      };

      const encodedResult = encodeURIComponent(JSON.stringify(resultForUrl));
      res.writeHead(303, { Location: `/transcript?result=${encodedResult}&meta=${durationMs}` });
      res.end();
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      if (err instanceof TranscriptError) {
        console.error(`[transcript] Error for ${TRANSCRIPT_VIDEO_ID} after ${durationMs}ms: ${err.name} (${err.statusCode}): ${err.message}`);
        const userMessage = err.message;
        const encodedError = encodeURIComponent(userMessage);
        res.writeHead(303, { Location: `/transcript?error=${encodedError}` });
      } else {
        console.error(`[transcript] Unexpected error for ${TRANSCRIPT_VIDEO_ID} after ${durationMs}ms:`, err);
        const encodedError = encodeURIComponent('Er is een onbekende fout opgetreden bij het ophalen van het transcript.');
        res.writeHead(303, { Location: `/transcript?error=${encodedError}` });
      }
      res.end();
    }
    return;
  }

  // --- Root pagina (beveiligd) ---
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloud AI POC</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>✅ Cloud AI POC</h1>
    <p>De beveiligde POC-webapp draait op Vercel. Basic Auth is actief.</p>
    <p style="margin-top:1rem;"><a href="/test-prompt" style="color:#3b82f6;">🧪 Test de DeepSeek-koppeling →</a></p>
    <p style="margin-top:0.5rem;"><a href="/transcript" style="color:#3b82f6;">🎬 YouTube Transcript ophalen →</a></p>
    <div class="badge">Protected by HTTP Basic Auth</div>
  </div>
</body>
</html>`);
    return;
  }

  // --- 404 voor onbekende routes ---
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/** Vercel entrypoint — Node.js (req, res) pattern. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

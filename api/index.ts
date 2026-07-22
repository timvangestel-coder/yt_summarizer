/**
 * Vercel Serverless Function — Node.js (req, res) pattern.
 * Alle routes worden via rewrites in vercel.json naar deze functie gestuurd.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Environment variables ───────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD;
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;
const OPENCODE_ENDPOINT = process.env.OPENCODE_ENDPOINT || 'https://opencode.ai/zen/v1/chat/completions';
const OPENCODE_MODEL_ID = process.env.OPENCODE_MODEL_ID || 'deepseek-v4-flash-free';
const DEEPSEEK_TIMEOUT = Number(process.env.DEEPSEEK_TIMEOUT) || 60000;
const TEST_PROMPT = process.env.TEST_PROMPT || 'Vat in één zin samen wat een REST API is.';

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
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT);

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
      throw { category: 'timeout', message: `Het model reageerde niet binnen de time-out van ${DEEPSEEK_TIMEOUT / 1000} seconden.` } satisfies DeepSeekError;
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderFormPage());
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderFormPage(undefined, result.content, meta));
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderFormPage(userMessage));
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

import { IncomingMessage, ServerResponse } from 'node:http';

const APP_PASSWORD = process.env.APP_PASSWORD;

/** Parse the Basic Auth credentials from the Authorization header. */
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

/** Send a 401 response that triggers the browser's Basic Auth dialog. */
function requireAuth(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="Cloud AI POC", charset="UTF-8"');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Authorization required' }));
}

/** Main request handler voor alle routes (behalve /health, die gaat via api/health.ts). */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // --- Healthcheck (openbaar) — mocht hij hier toch komen via rewrite ---
  if (method === 'GET' && url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // --- Alle andere routes vereisen authenticatie ---
  if (!APP_PASSWORD) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'APP_PASSWORD not configured' }));
    return;
  }

  const providedPassword = parseBasicAuth(req.headers);
  if (providedPassword !== APP_PASSWORD) {
    requireAuth(res);
    return;
  }

  // --- Authenticated request ---
  if (method === 'GET' && (url === '/' || url === '')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloud AI POC</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #0f172a; color: #e2e8f0;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 2.5rem;
      max-width: 480px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #94a3b8; line-height: 1.6; }
    .badge {
      display: inline-block; margin-top: 1.5rem;
      background: #334155; padding: 0.4rem 0.8rem; border-radius: 6px;
      font-size: 0.8rem; color: #cbd5e1;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ Cloud AI POC</h1>
    <p>De beveiligde POC-webapp draait op Vercel. Basic Auth is actief.</p>
    <div class="badge">Protected by HTTP Basic Auth</div>
  </div>
</body>
</html>`);
    return;
  }

  // --- 404 voor onbekende routes ---
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found' }));
}

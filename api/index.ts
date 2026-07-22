/**
 * Vercel Serverless Function — Node.js (req, res) pattern.
 * Alle routes worden via rewrites in vercel.json naar deze functie gestuurd.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const APP_PASSWORD = process.env.APP_PASSWORD;

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

/** Verwerk een inkomend verzoek. */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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

  // --- Root pagina (beveiligd) ---
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/** Vercel entrypoint — Node.js (req, res) pattern. */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Vercel Serverless Function — vervangt de server capture aanpak.
 * Alle routes worden via rewrites in vercel.json naar deze functie gestuurd.
 */
const APP_PASSWORD = process.env.APP_PASSWORD;

/** Parse Basic Auth credentials uit de Authorization header. */
function parseBasicAuth(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return null;
    return decoded.slice(colonIndex + 1);
  } catch {
    return null;
  }
}

export default function handler(
  request: Request,
): Response {
  const url = new URL(request.url);
  const method = request.method || 'GET';

  // --- Healthcheck (openbaar) ---
  if (method === 'GET' && url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Alle andere routes vereisen authenticatie ---
  if (!APP_PASSWORD) {
    return new Response(JSON.stringify({ error: 'APP_PASSWORD not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const providedPassword = parseBasicAuth(request.headers.get('authorization'));
  if (providedPassword !== APP_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Authorization required' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="Cloud AI POC", charset="UTF-8"',
      },
    });
  }

  // --- Root pagina (beveiligd) ---
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    return new Response(
      `<!DOCTYPE html>
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
</html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  }

  // --- 404 voor onbekende routes ---
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

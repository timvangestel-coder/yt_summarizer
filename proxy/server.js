/**
 * Generieke Reverse Proxy — Node.js built-ins only (0 npm dependencies).
 *
 * Routes inkomende requests naar het doeldomein op basis van de
 * `x-forwarded-host` header, met API-key authenticatie.
 *
 * Gebruik:
 *   node server.js
 *   curl http://localhost:3000/health
 *   curl -H "x-api-key: test123" -H "x-forwarded-host: www.youtube.com" \
 *     "http://localhost:3000/youtubei/v1/player?videoId=RyQD8jQrenU"
 *
 * @module
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Configuratie laden ─────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

/** @type {import('./config.json')} */
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
  console.error(`Fout bij laden configuratie (${configPath}):`, err.message);
  process.exit(1);
}

// API-key kan overschreven worden via environment variable (voor NSSM service)
const API_KEY = process.env.PROXY_API_KEY || config.apiKey;
const PORT = Number(process.env.PORT) || config.port;
const BIND_ADDRESS = process.env.BIND_ADDRESS || config.bindAddress;
const DOMAINS = config.allowedDomains;

if (!API_KEY) {
  console.error('Geen API-key geconfigureerd. Zet PROXY_API_KEY environment variable of apiKey in config.json.');
  process.exit(1);
}

if (!DOMAINS || Object.keys(DOMAINS).length === 0) {
  console.error('Geen toegestane domeinen geconfigureerd in allowedDomains.');
  process.exit(1);
}

console.log(`Proxy configuratie geladen: ${Object.keys(DOMAINS).length} domein(en)`);

// ── Helpers ────────────────────────────────────────────────────────

/** Formatteer een Date naar ISO-string voor logging. */
function timestamp() {
  return new Date().toISOString();
}

/** Escape HTML-special chars (minimaal, voor foutmeldingen). */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Request handler ────────────────────────────────────────────────

/**
 * Valideer het inkomende request en stuur het door naar het doeldomein.
 * Bij streaming worden data direct doorgestuurd zonder buffering.
 *
 * @param {import('node:http').IncomingMessage} clientReq - Inkomend request
 * @param {import('node:http').ServerResponse} clientRes - Response naar client
 */
function handleRequest(clientReq, clientRes) {
  const startTime = Date.now();
  const method = clientReq.method || 'GET';
  const pathname = clientReq.url || '/';

  // --- Healthcheck (geen authenticatie nodig) ---
  if (method === 'GET' && pathname === '/health') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: timestamp(),
      allowedDomains: Object.keys(DOMAINS),
    }));
    console.log(`[${timestamp()}] HEALTH 200 — ${Date.now() - startTime}ms`);
    return;
  }

  // --- API-key authenticatie ---
  const apiKey = clientReq.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    clientRes.writeHead(401, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Ongeldige of ontbrekende API-key.' }));
    console.log(`[${timestamp()}] AUTH_FAIL ${method} ${pathname} — ${Date.now() - startTime}ms`);
    return;
  }

  // --- Bepaal doeldomein via x-forwarded-host ---
  const forwardedHost = clientReq.headers['x-forwarded-host'];
  if (!forwardedHost || typeof forwardedHost !== 'string') {
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'x-forwarded-host header is vereist.' }));
    console.log(`[${timestamp()}] NO_HOST ${method} ${pathname} — ${Date.now() - startTime}ms`);
    return;
  }

  const domainConfig = DOMAINS[forwardedHost];
  if (!domainConfig) {
    clientRes.writeHead(403, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: `Domein '${forwardedHost}' staat niet in de whitelist.`,
      allowedDomains: Object.keys(DOMAINS),
    }));
    console.log(`[${timestamp()}] FORBIDDEN ${method} ${pathname} (host=${forwardedHost}) — ${Date.now() - startTime}ms`);
    return;
  }

  // --- Bouw target URL ---
  const targetBase = domainConfig.target.replace(/\/+$/, '');
  const targetPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const queryString = clientReq.url && clientReq.url.includes('?') ? clientReq.url.slice(clientReq.url.indexOf('?')) : '';
  const targetUrl = `${targetBase}${targetPath}${queryString}`;

  // --- Bepaal het juiste http(s) module ---
  const isSecure = targetBase.startsWith('https://');
  const httpModule = isSecure ? https : http;

  // --- Bouw headers voor het door te sturen verzoek ---
  const outgoingHeaders = {
    ...clientReq.headers,
    ...(domainConfig.headers || {}),
  };

  // Verwijder headers die niet doorgestuurd mogen worden
  delete outgoingHeaders['x-api-key'];
  delete outgoingHeaders['x-forwarded-host'];
  delete outgoingHeaders['host'];
  delete outgoingHeaders['connection'];
  delete outgoingHeaders['keep-alive'];
  delete outgoingHeaders['proxy-connection'];
  delete outgoingHeaders['transfer-encoding']; // laat Node.js dit zelf bepalen

  // Stel de Host-header in op het doeldomein
  const targetUrlObj = new URL(targetBase);
  outgoingHeaders['host'] = targetUrlObj.host;

  // --- Voer het doorstuur-request uit (streaming) ---
  const proxyReq = httpModule.request(
    targetUrl,
    {
      method: method,
      headers: outgoingHeaders,
      rejectUnauthorized: true,
      timeout: 30000, // 30s timeout per request
    },
    (proxyRes) => {
      // Stuur de response-headers door
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders['transfer-encoding']; // laat Node.js dit bepalen
      delete responseHeaders['connection'];
      delete responseHeaders['keep-alive'];

      clientRes.writeHead(proxyRes.statusCode || 502, responseHeaders);

      // Stream de response-body direct door
      proxyRes.pipe(clientRes);

      // Logging bij voltooiing
      const duration = Date.now() - startTime;
      console.log(`[${timestamp()}] ${method} ${pathname} → ${forwardedHost} ${proxyRes.statusCode} — ${duration}ms`);
    }
  );

  // Timeout afhandeling
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!clientRes.writableEnded) {
      clientRes.writeHead(504, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Doorstuur-request timeout (30s).' }));
    }
    console.log(`[${timestamp()}] TIMEOUT ${method} ${pathname} → ${forwardedHost} — ${Date.now() - startTime}ms`);
  });

  // Foutafhandeling
  proxyReq.on('error', (err) => {
    if (clientRes.writableEnded) return;
    const statusCode = err.code === 'ECONNREFUSED' ? 502 : 502;
    clientRes.writeHead(statusCode, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `Doorstuurfout: ${err.message}` }));
    console.log(`[${timestamp()}] ERROR ${method} ${pathname} → ${forwardedHost}: ${err.message} — ${Date.now() - startTime}ms`);
  });

  // Stream de inkomende request-body naar het doeldomein
  clientReq.pipe(proxyReq);
}

// ── Server opstarten ───────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`✅ Reverse proxy gestart op http://${BIND_ADDRESS}:${PORT}`);
  console.log(`   Toegestane domeinen: ${Object.keys(DOMAINS).join(', ')}`);
  console.log(`   API-key authenticatie: actief`);
  console.log(`   Healthcheck: http://${BIND_ADDRESS}:${PORT}/health`);
});

// ── Graceful shutdown ──────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[${timestamp()}] ${signal} ontvangen — netjes afsluiten...`);
  server.close(() => {
    console.log(`[${timestamp()}] Server gestopt.`);
    process.exit(0);
  });

  // Forceer afsluiten na 5 seconden als de server niet wil stoppen
  setTimeout(() => {
    console.error(`[${timestamp()}] Geforceerde afsluiting na timeout.`);
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Windows: Ctrl+C (SIGINT) werkt out-of-the-box in Node.js op Windows.
// Ctrl+Break wordt niet ondersteund zonder native addon.

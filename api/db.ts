/**
 * Database connection module — Neon PostgreSQL.
 *
 * Module-level singleton connection pool (hergebruikt over warme Vercel-invocaties).
 * Connection string uit process.env.DATABASE_URL (cloudsecret).
 * TLS/SSL verplicht (sslmode=require).
 */

import pg from 'pg';

const { Pool } = pg;

// ── Types ───────────────────────────────────────────────────────────

export interface DbTestResult {
  id: number;
  label: string;
  resultaat: string;
  aangemaakt_op: string;
}

// ── Connection pool (singleton) ─────────────────────────────────────

let pool: pg.Pool | null = null;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  console.error('[db] DATABASE_URL present:', !!url, 'length:', url?.length ?? 0, 'prefix:', url ? url.slice(0, 20) + '...' : 'NONE');
  if (!url) {
    throw new DbConfigError('DATABASE_URL is niet geconfigureerd.');
  }
  // Ensure sslmode=require is present
  if (!url.includes('sslmode=')) {
    return url + (url.includes('?') ? '&' : '?') + 'sslmode=require';
  }
  return url;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      ssl: {
        rejectUnauthorized: false, // Neon's SSL-certs zijn correct; false om compatibiliteit met
                                   // pg v8's sslmode=require→verify-full mapping te voorkomen
      },
      connectionTimeoutMillis: 10_000, // 10s timeout — past binnen Vercel's maxDuration
      idleTimeoutMillis: 30_000,
      max: 3, // kleine pool voor serverless
    });

    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', sanitizeError(err));
    });
  }
  return pool;
}

/** Sluit de pool (voor clean shutdown / tests). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Gezondheidscheck ────────────────────────────────────────────────

export async function checkConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      return { ok: true };
    } finally {
      client.release();
    }
  } catch (err) {
    // Debug: log de raw error voor диагностика
    const rawMessage = err instanceof Error ? err.message : String(err);
    const rawStack = err instanceof Error ? err.stack : '';
    console.error('[db] Raw connection error:', rawMessage);
    console.error('[db] Raw stack:', rawStack);
    return { ok: false, error: sanitizeError(err) };
  }
}

// ── Sanitized error helper ──────────────────────────────────────────

/**
 * Geeft een veilige foutmelding terug zonder connection string,
 * credentials of interne databasegegevens te lekken.
 */
export function sanitizeError(err: unknown): string {
  if (err instanceof DbConfigError) {
    return err.message;
  }

  const message = err instanceof Error ? err.message : String(err);

  // Herkenbare foutcategorieën — zonder details te lekken
  if (message.includes('getaddrinfo') || message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
    return 'Kan geen verbinding maken met de database-server. Controleer de hostnaam.';
  }
  if (message.includes('ECONNREFUSED')) {
    return 'Verbinding geweigerd door de database-server.';
  }
  if (message.includes('timeout') || message.includes('Timeout')) {
    return 'Database-verbinding duurde te lang. Probeer het later opnieuw.';
  }
  if (message.includes('authentication') || message.includes('password')) {
    return 'Ongeldige database-credentials.';
  }
  if (message.includes('SSL') || message.includes('ssl') || message.includes('TLS')) {
    return 'SSL/TLS-verbinding mislukt. Controleer of de database SSL vereist.';
  }
  if (message.includes('does not exist')) {
    return 'Database bestaat niet. Controleer de database-naam.';
  }
  if (message.includes('no pg_hba.conf')) {
    return 'Geen toegang tot de database voor dit IP-adres.';
  }
  if (message.includes('too many connections')) {
    return 'Database heeft te veel verbindingen. Probeer het later opnieuw.';
  }

  // Fallback — veilig, geen interne details
  return 'Er is een databasefout opgetreden. Controleer de configuratie en probeer het opnieuw.';
}

// ── Custom error ────────────────────────────────────────────────────

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

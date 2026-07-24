/**
 * Reproduceerbare migratie — maakt de minimale tabelstructuur aan.
 *
 * Idempotent: kan veilig bij elke deploy worden uitgevoerd (CREATE TABLE IF NOT EXISTS).
 */

import { getPool, sanitizeError, type DbTestResult } from './db.js';

// ── Types ───────────────────────────────────────────────────────────

export interface MigrationResult {
  success: true;
  message: string;
}

export interface MigrationError {
  success: false;
  error: string;
}

export interface Samenvatting {
  id: number;
  video_id: string;
  video_url: string;
  taal: string;
  snippet_count: number;
  transcript: string | null;
  samenvatting: string;
  model: string | null;
  token_usage_prompt: number | null;
  token_usage_completion: number | null;
  token_usage_total: number | null;
  duur_ms: number | null;
  aangemaakt_op: string;
}

// ── Migratie ────────────────────────────────────────────────────────

const CREATE_TEST_RESULTATEN_TABLE = `
  CREATE TABLE IF NOT EXISTS test_resultaten (
    id            SERIAL PRIMARY KEY,
    label         VARCHAR(255) NOT NULL,
    resultaat     TEXT NOT NULL,
    aangemaakt_op TIMESTAMPTZ DEFAULT NOW()
  );
`;

const CREATE_SAMENVATTINGEN_TABLE = `
  CREATE TABLE IF NOT EXISTS samenvattingen (
    id                    SERIAL PRIMARY KEY,
    video_id              VARCHAR(11) NOT NULL,
    video_url             TEXT NOT NULL,
    taal                  VARCHAR(10) DEFAULT 'onbekend',
    snippet_count         INTEGER DEFAULT 0,
    transcript            TEXT,
    samenvatting          TEXT NOT NULL,
    model                 VARCHAR(100),
    token_usage_prompt    INTEGER,
    token_usage_completion INTEGER,
    token_usage_total     INTEGER,
    duur_ms               INTEGER,
    aangemaakt_op         TIMESTAMPTZ DEFAULT NOW()
  );
`;

const CREATE_UNIQUE_VIDEO_ID_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_samenvattingen_video_id
  ON samenvattingen(video_id);
`;

/**
 * Voer de migratie uit (idempotent).
 * Kan worden aangeroepen vanuit de request-handler of als zelfstandig endpoint.
 */
export async function runMigration(): Promise<MigrationResult | MigrationError> {
  try {
    const pool = getPool();
    await pool.query(CREATE_TEST_RESULTATEN_TABLE);
    await pool.query(CREATE_SAMENVATTINGEN_TABLE);
    await pool.query(CREATE_UNIQUE_VIDEO_ID_INDEX);
    return {
      success: true,
      message: 'Migratie succesvol uitgevoerd (test_resultaten + samenvattingen tabellen bestaan).',
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeError(err),
    };
  }
}

/**
 * Sla een testresultaat op.
 */
export async function insertTestResult(label: string, resultaat: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    'INSERT INTO test_resultaten (label, resultaat) VALUES ($1, $2) RETURNING id',
    [label, resultaat],
  );
  const id = result.rows[0].id;
  // pg returns SERIAL as number, but types say string | number
  return typeof id === 'number' ? id : Number(id);
}

/**
 * Haal alle testresultaten op (nieuwste eerst).
 */
export async function getAllTestResults(): Promise<DbTestResult[]> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, label, resultaat, aangemaakt_op FROM test_resultaten ORDER BY aangemaakt_op DESC LIMIT 100',
  );
  return result.rows as DbTestResult[];
}

// ── Samenvattingen CRUD ─────────────────────────────────────────────

export interface InsertSummaryParams {
  videoId: string;
  videoUrl: string;
  taal: string;
  snippetCount: number;
  transcript: string;
  samenvatting: string;
  model: string;
  tokenUsagePrompt: number;
  tokenUsageCompletion: number;
  tokenUsageTotal: number;
  duurMs: number;
}

/**
 * Sla een samenvatting op. Gebruikt INSERT ... ON CONFLICT DO NOTHING
 * om dubbele opslag voor dezelfde video_id te voorkomen.
 * Retourneert het id bij nieuwe insert, of null bij duplicate.
 */
export async function insertSummary(params: InsertSummaryParams): Promise<number | null> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO samenvattingen
      (video_id, video_url, taal, snippet_count, transcript, samenvatting,
       model, token_usage_prompt, token_usage_completion, token_usage_total, duur_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (video_id) DO NOTHING
     RETURNING id`,
    [
      params.videoId,
      params.videoUrl,
      params.taal,
      params.snippetCount,
      params.transcript,
      params.samenvatting,
      params.model,
      params.tokenUsagePrompt,
      params.tokenUsageCompletion,
      params.tokenUsageTotal,
      params.duurMs,
    ],
  );
  if (result.rows.length === 0) return null; // duplicate
  const id = result.rows[0].id;
  return typeof id === 'number' ? id : Number(id);
}

/**
 * Haal een samenvatting op via id.
 */
export async function getSummaryById(id: number): Promise<Samenvatting | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM samenvattingen WHERE id = $1',
    [id],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as Samenvatting;
}

/**
 * Zoek een samenvatting op via video_id (voor duplicate detectie).
 */
export async function getSummaryByVideoId(videoId: string): Promise<Samenvatting | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM samenvattingen WHERE video_id = $1',
    [videoId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as Samenvatting;
}

/**
 * Reproduceerbare migratie — maakt de minimale tabelstructuur aan.
 *
 * Idempotent: kan veilig bij elke deploy worden uitgevoerd (CREATE TABLE IF NOT EXISTS).
 */

import { getPool, sanitizeError } from './db.js';

// ── Types ───────────────────────────────────────────────────────────

export interface MigrationResult {
  success: true;
  message: string;
}

export interface MigrationError {
  success: false;
  error: string;
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

/**
 * Voer de migratie uit (idempotent).
 * Kan worden aangeroepen vanuit de request-handler of als zelfstandig endpoint.
 */
export async function runMigration(): Promise<MigrationResult | MigrationError> {
  try {
    const pool = getPool();
    await pool.query(CREATE_TEST_RESULTATEN_TABLE);
    return {
      success: true,
      message: 'Migratie succesvol uitgevoerd (test_resultaten tabel bestaat).',
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
  return result.rows[0].id as number;
}

/**
 * Haal alle testresultaten op (nieuwste eerst).
 */
export async function getAllTestResults(): Promise<Array<{ id: number; label: string; resultaat: string; aangemaakt_op: string }>> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, label, resultaat, aangemaakt_op FROM test_resultaten ORDER BY aangemaakt_op DESC LIMIT 100',
  );
  return result.rows;
}

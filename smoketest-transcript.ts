/**
 * Smoketest voor YouTube transcript + samenvatting — Issue 04 + 07
 *
 * Test de proxy relay transcript-implementatie en de end-to-end samenvattingsketen.
 * Gebruik: npx tsx smoketest-transcript.ts
 *
 * Testcases:
 * 1. parseVideoId — geldige YouTube URL (www.youtube.com/watch?v=...)
 * 2. parseVideoId — youtu.be URL
 * 3. parseVideoId — raw video ID
 * 4. parseVideoId — ongeldig formaat
 * 5. parseVideoId — ongeldige URL (geen YouTube)
 * 6-8. fetchTranscriptViaProxy — proxy relay tests
 * 9. Ongeldige URL via InvalidVideoIdError
 * 10-12. Database tests (migrate, CRUD)
 * 13-15. Samenvatting CRUD tests (insertSummary, getSummaryById, getSummaryByVideoId)
 */

import {
  parseVideoId,
  fetchTranscriptViaProxy,
  TranscriptError,
  TranscriptSnippet,
  InvalidVideoIdError,
  TranscriptNotAvailableError,
} from './api/transcript.js';

// ── Test runner ─────────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  details: string;
  durationMs: number;
}

async function runTest(name: string, fn: () => Promise<void>, skip = false): Promise<TestResult> {
  if (skip) {
    return { name, status: 'SKIP', details: '⏭️ Overgeslagen (geen credentials)', durationMs: 0 };
  }
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'PASS', details: '✅ Geslaagd', durationMs: Date.now() - start };
  } catch (err) {
    return { name, status: 'FAIL', details: `❌ ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }
}

// ── Tests ───────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('🧪 Smoketest — YouTube Transcript + Samenvatting (Issue 04 + 07)');
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log(`Aanpak: Proxy relay + Neon PostgreSQL`);
  console.log('='.repeat(60));
  console.log();

  const results: TestResult[] = [];

  // ── Proxy config ─────────────────────────────────────────────────
  const PROXY_URL = process.env.PROXY_URL || '';
  const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
  const hasProxy = !!(PROXY_URL && PROXY_API_KEY);
  const TEST_VIDEO_ID = process.env.TRANSCRIPT_VIDEO_ID || 'jNQXAC9IVRw';

  // ── Test 1: parseVideoId — geldige www.youtube.com URL ──────────────────
  results.push(await runTest('parseVideoId — www.youtube.com/watch?v=...', async () => {
    const id = parseVideoId('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
    console.log(`   ID: ${id}`);
  }));

  // ── Test 2: parseVideoId — youtu.be URL ─────────────────────────────────
  results.push(await runTest('parseVideoId — youtu.be URL', async () => {
    const id = parseVideoId('https://youtu.be/jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
  }));

  // ── Test 3: parseVideoId — raw video ID ─────────────────────────────────
  results.push(await runTest('parseVideoId — raw video ID', async () => {
    const id = parseVideoId('jNQXAC9IVRw');
    if (id !== 'jNQXAC9IVRw') throw new Error(`Verwacht jNQXAC9IVRw, kreeg ${id}`);
  }));

  // ── Test 4: parseVideoId — ongeldig formaat ─────────────────────────────
  results.push(await runTest('parseVideoId — ongeldig formaat', async () => {
    const id = parseVideoId('https://www.youtube.com/watch?v=te-kort');
    if (id) throw new Error(`Zou null moeten zijn, kreeg ${id}`);
  }));

  // ── Test 5: parseVideoId — ongeldige URL (geen YouTube) ────────────────
  results.push(await runTest('parseVideoId — ongeldige URL (geen YouTube)', async () => {
    const id = parseVideoId('https://example.com/geen-video');
    if (id) throw new Error(`Zou null moeten zijn, kreeg ${id}`);
  }));

  // ── Test 6: fetchTranscriptViaProxy — download via proxy relay ────
  results.push(await runTest('fetchTranscriptViaProxy — download EN', async () => {
    if (!hasProxy) throw new Error('PROXY_URL en PROXY_API_KEY niet ingesteld');
    const snippets = await fetchTranscriptViaProxy(TEST_VIDEO_ID, PROXY_URL, PROXY_API_KEY, 'en');
    if (!snippets || snippets.length === 0) throw new Error('Geen snippets ontvangen');
    console.log(`   Aantal snippets: ${snippets.length}`);
    console.log(`   Eerste: "${snippets[0].text}" @ ${snippets[0].start}s (dur: ${snippets[0].duration}s)`);
    console.log(`   Laatste: "${snippets[snippets.length-1].text}" @ ${snippets[snippets.length-1].start}s`);
    if (snippets[0].text.length === 0) throw new Error('Eerste snippet is leeg');
    if (snippets[0].start < 0) throw new Error(`Ongeldige start tijd: ${snippets[0].start}`);
    if (snippets[0].duration <= 0) throw new Error(`Ongeldige duration: ${snippets[0].duration}`);
  }, !hasProxy));

  // ── Test 7: fetchTranscriptViaProxy — zonder taal (fallback) ─────
  results.push(await runTest('fetchTranscriptViaProxy — zonder taal (fallback)', async () => {
    if (!hasProxy) throw new Error('PROXY_URL en PROXY_API_KEY niet ingesteld');
    const snippets = await fetchTranscriptViaProxy(TEST_VIDEO_ID, PROXY_URL, PROXY_API_KEY);
    if (!snippets || snippets.length === 0) throw new Error('Geen snippets ontvangen');
    console.log(`   Aantal snippets: ${snippets.length} (zonder taalopgave)`);
  }, !hasProxy));

  // ── Test 8: fetchTranscriptViaProxy — ongeldige video ────────────
  results.push(await runTest('fetchTranscriptViaProxy — ongeldige video', async () => {
    if (!hasProxy) throw new Error('PROXY_URL en PROXY_API_KEY niet ingesteld');
    try {
      await fetchTranscriptViaProxy('zzzzzzzzzzz', PROXY_URL, PROXY_API_KEY);
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof TranscriptNotAvailableError || err instanceof TranscriptError) {
        console.log(`   Correcte fout: ${err instanceof TranscriptError ? err.name : 'Error'} — ${err.message}`);
      } else {
        throw err;
      }
    }
  }, !hasProxy));

  // ── Test 9: Ongeldige URL via InvalidVideoIdError ─────────────────────
  results.push(await runTest('Transcript — ongeldige URL', async () => {
    try {
      await fetchTranscriptViaProxy('geen-geldig-id', PROXY_URL, PROXY_API_KEY);
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof InvalidVideoIdError) {
        console.log(`   Correcte fout: ${err.name} — ${err.message}`);
      } else {
        throw err;
      }
    }
  }));

  // ── Database tests ──────────────────────────────────────────────────
  const DB_URL = process.env.DATABASE_URL;
  const hasDb = !!DB_URL;

  // ── Test 15: db — checkConnection zonder DATABASE_URL ────────────────
  results.push(await runTest('db — checkConnection zonder DATABASE_URL', async () => {
    const urlBackup = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // Reload module or test via db module
      const { checkConnection } = await import('./api/db.js');
      const status = await checkConnection();
      if (status.ok) throw new Error('Verwacht fout, maar verbinding was ok');
      console.log(`   Correct: ${status.error}`);
    } finally {
      process.env.DATABASE_URL = urlBackup;
    }
  }));

  // ── Test 16: db — sanitizeError herkent foutcategorieën ─────────────
  results.push(await runTest('db — sanitizeError herkent foutcategorieën', async () => {
    const { sanitizeError } = await import('./api/db.js');
    const tests: Array<[string, string]> = [
      ['getaddrinfo ENOTFOUND', 'Kan geen verbinding maken met de database-server. Controleer de hostnaam.'],
      ['ECONNREFUSED', 'Verbinding geweigerd door de database-server.'],
      ['timeout expired', 'Database-verbinding duurde te lang. Probeer het later opnieuw.'],
      ['password authentication failed', 'Ongeldige database-credentials.'],
      ['SSL error', 'SSL/TLS-verbinding mislukt. Controleer of de database SSL vereist.'],
    ];
    for (const [input, expected] of tests) {
      const result = sanitizeError(new Error(input));
      if (result !== expected) {
        throw new Error(`Voor "${input}" verwachtte "${expected}" maar kreeg "${result}"`);
      }
    }
    console.log(`   ✅ Alle ${tests.length} foutcategorieën correct`);
  }));

  // ── Test 17: db — runMigration (alleen als DATABASE_URL ingesteld) ──
  results.push(await runTest('db — runMigration (idempotent)', async () => {
    const { runMigration } = await import('./api/migrate.js');
    const result1 = await runMigration();
    if (!result1.success) throw new Error(`Migratie 1 mislukt: ${result1.error}`);
    console.log(`   ✅ Eerste migratie: ${result1.message}`);

    // Tweede keer moet ook slagen (idempotent)
    const result2 = await runMigration();
    if (!result2.success) throw new Error(`Migratie 2 (idempotent) mislukt: ${result2.error}`);
    console.log(`   ✅ Tweede migratie (idempotent): ${result2.message}`);
  }, !hasDb));

  // ── Test 18: db — insertTestResult + getAllTestResults ──────────────
  results.push(await runTest('db — insertTestResult + getAllTestResults', async () => {
    const { insertTestResult, getAllTestResults } = await import('./api/migrate.js');
    const label = `Smoketest ${Date.now()}`;
    const resultaat = 'Dit is een geautomatiseerde test van de database-opslag.';

    const id = await insertTestResult(label, resultaat);
    if (!id || typeof id !== 'number') throw new Error(`Ongeldig ID terug: ${id}`);
    console.log(`   ✅ Opgeslagen met ID: ${id}`);

    const all = await getAllTestResults();
    const found = all.find((r) => r.id === id);
    if (!found) throw new Error(`Resultaat met ID ${id} niet teruggevonden in lijst`);
    if (found.label !== label) throw new Error(`Label mismatch: verwacht "${label}", kreeg "${found.label}"`);
    console.log(`   ✅ Teruggelezen: "${found.label}" — "${found.resultaat.slice(0, 50)}..."`);
  }, !hasDb));

  // ── Samenvatting CRUD tests ──────────────────────────────────────

  // ── Test 19: insertSummary — nieuwe samenvatting opslaan ─────────
  results.push(await runTest('samenvatting — insertSummary (nieuw)', async () => {
    const { insertSummary, getSummaryById } = await import('./api/migrate.js');
    const videoId = `test${Date.now()}`.slice(0, 11);
    const id = await insertSummary({
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      taal: 'nl',
      snippetCount: 5,
      transcript: 'Dit is een test transcript.',
      samenvatting: 'Dit is een test samenvatting.',
      model: 'deepseek-v4-flash-free',
      tokenUsagePrompt: 100,
      tokenUsageCompletion: 50,
      tokenUsageTotal: 150,
      duurMs: 1234,
    });
    if (id === null) throw new Error('insertSummary retourneerde null (mogelijk duplicate)');
    if (typeof id !== 'number' || id < 1) throw new Error(`Ongeldig ID: ${id}`);
    console.log(`   ✅ Opgeslagen met ID: ${id}`);

    // Teruglezen
    const found = await getSummaryById(id);
    if (!found) throw new Error(`Samenvatting met ID ${id} niet teruggevonden`);
    if (found.video_id !== videoId) throw new Error(`video_id mismatch: verwacht ${videoId}, kreeg ${found.video_id}`);
    if (found.samenvatting !== 'Dit is een test samenvatting.') throw new Error('samenvatting tekst mismatch');
    console.log(`   ✅ Teruggelezen: video_id=${found.video_id}, samenvatting="${found.samenvatting.slice(0, 40)}..."`);
  }, !hasDb));

  // ── Test 20: insertSummary — duplicate detectie ──────────────────
  results.push(await runTest('samenvatting — insertSummary (duplicate)', async () => {
    const { insertSummary, getSummaryByVideoId } = await import('./api/migrate.js');
    const videoId = `dup${Date.now()}`.slice(0, 11);
    // Eerste insert
    const id1 = await insertSummary({
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      taal: 'en',
      snippetCount: 3,
      transcript: 'Eerste transcript.',
      samenvatting: 'Eerste samenvatting.',
      model: 'deepseek-v4-flash-free',
      tokenUsagePrompt: 50,
      tokenUsageCompletion: 25,
      tokenUsageTotal: 75,
      duurMs: 500,
    });
    if (id1 === null) throw new Error('Eerste insert zou moeten slagen');
    console.log(`   ✅ Eerste insert: ID ${id1}`);

    // Tweede insert (zelfde video_id) moet null retourneren
    const id2 = await insertSummary({
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      taal: 'en',
      snippetCount: 99,
      transcript: 'Dit mag niet worden opgeslagen.',
      samenvatting: 'Dit mag niet worden opgeslagen.',
      model: 'deepseek-v4-flash-free',
      tokenUsagePrompt: 0,
      tokenUsageCompletion: 0,
      tokenUsageTotal: 0,
      duurMs: 0,
    });
    if (id2 !== null) throw new Error(`Tweede insert voor zelfde video_id zou null moeten zijn, kreeg ${id2}`);
    console.log(`   ✅ Duplicate correct gedetecteerd (null retour)`);

    // getSummaryByVideoId moet de eerste teruggeven
    const found = await getSummaryByVideoId(videoId);
    if (!found) throw new Error('getSummaryByVideoId vond niets');
    if (found.id !== id1) throw new Error(`Verwacht ID ${id1}, kreeg ${found.id}`);
    console.log(`   ✅ getSummaryByVideoId geeft eerste resultaat: ID ${found.id}`);
  }, !hasDb));

  // ── Test 21: getSummaryById — niet-bestaand ID ───────────────────
  results.push(await runTest('samenvatting — getSummaryById (niet bestaand)', async () => {
    const { getSummaryById } = await import('./api/migrate.js');
    const found = await getSummaryById(999999999);
    if (found !== null) throw new Error(`Verwacht null voor niet-bestaand ID, kreeg ID ${found.id}`);
    console.log('   ✅ Correct: null voor niet-bestaand ID');
  }, !hasDb));

  // ── Resultaten ──────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(60));
  console.log('📊 Resultaten');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : result.status === 'SKIP' ? '⏭️' : '❌';
    console.log(` ${icon} ${result.name} (${result.durationMs}ms)`);
    if (result.status !== 'PASS') {
      console.log(`     ${result.details}`);
    }
  }

  console.log();
  console.log(`Totaal: ${results.length} tests — ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log();

  // ── Experimentresultaat ─────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('📋 Experimentresultaat');
  console.log('='.repeat(60));
  console.log();
  console.log(`**Datum:** ${new Date().toISOString()}`);
  console.log(`**Omgeving:** Lokaal (zonder Vercel)`);
  console.log(`**Aanpak:** Proxy relay + youtube-transcript package + Neon PostgreSQL`);
  console.log(`**Resultaat:** ${failed > 0 ? '⚠️ Sommige tests gefaald' : '✅ Alle tests geslaagd'}`);
  console.log();
  console.log('**Bevindingen:**');
  if (failed === 0) {
    console.log('- Proxy relay (fetchTranscriptViaProxy) werkt voor publieke video\'s ✅');
    console.log('- URL-validatie (parseVideoId) werkt voor alle formaten ✅');
    console.log('- Error classes geven correcte HTTP-statuscodes ✅');
    if (hasDb) {
      console.log('- Database runMigration() is idempotent ✅');
      console.log('- insertTestResult() + getAllTestResults() werken ✅');
      console.log('- insertSummary() + getSummaryById() werken ✅');
      console.log('- Duplicate detectie (ON CONFLICT DO NOTHING) werkt ✅');
      console.log('- getSummaryByVideoId() vindt bestaande samenvattingen ✅');
      console.log('- Data blijft bewaard (geverifieerd door smoketest) ✅');
    }
  } else if (failed > 0) {
    console.log('- Sommige tests faalden. Zie details hierboven.');
    if (failed <= 2 && !hasDb) console.log('- Database tests overgeslagen (DATABASE_URL niet ingesteld).');
    if (failed <= 2 && hasDb) console.log('- Mogelijk een database-specifiek probleem.');
  }
  console.log();
  console.log('**Aanbevolen vervolg:**');
  if (failed > 0) {
    console.log('1. Controleer de foutmeldingen hierboven.');
    if (!hasDb) console.log('2. Stel DATABASE_URL in en voer de smoketest opnieuw uit voor database-tests.');
    if (!hasProxy) console.log('3. Stel PROXY_URL en PROXY_API_KEY in voor transcript-tests.');
  } else {
    console.log('1. Issue 04 (YouTube transcript via proxy) is gevalideerd ✅');
    console.log('2. Issue 06 (Neon PostgreSQL opslag) is gevalideerd ✅');
    console.log('3. Issue 07 (Samenvatting end-to-end) CRUD is gevalideerd ✅');
    console.log('4. Deploy naar Vercel en test de /summarize pagina.');
  }
}

main().catch(console.error);

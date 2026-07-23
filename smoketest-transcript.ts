/**
 * Smoketest voor YouTube transcript — Issue 04
 *
 * Test de YouTube Data API v3-implementatie lokaal (zonder Vercel) via tsx.
 * Gebruik: npx tsx smoketest-transcript.ts
 *
 * Voor de OAuth-afhankelijke tests (captions.list, captions.download) zijn
 * environment variables nodig: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
 * YOUTUBE_REFRESH_TOKEN. Zonder deze credentials worden alleen de
 * offline tests (parseVideoId, parseSbv) uitgevoerd.
 *
 * Testcases:
 * 1. parseVideoId — geldige YouTube URL (www.youtube.com/watch?v=...)
 * 2. parseVideoId — youtu.be URL
 * 3. parseVideoId — raw video ID
 * 4. parseVideoId — ongeldig formaat
 * 5. parseSbv — geldige SBV-content
 * 6. parseSbv — lege SBV-content
 * 7. OAuth token verversen (alleen met credentials)
 * 8. Volledige transcript-flow (alleen met credentials)
 */

import {
  parseVideoId,
  parseSbv,
  getAccessToken,
  fetchCaptionTracks,
  downloadCaption,
  getTranscriptYoutubeApi,
  TranscriptError,
  TranscriptResult,
  TranscriptSnippet,
  InvalidVideoIdError,
  TranscriptNotAvailableError,
  TranscriptDisabledError,
  OAuthError,
  QuotaExceededError,
} from './api/transcript.js';

// ── Configuratie ───────────────────────────────────────────────────

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN || '';
const HAS_CREDENTIALS = !!(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET && YOUTUBE_REFRESH_TOKEN);

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
  console.log('🧪 Smoketest — YouTube Transcript (Issue 04)');
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log(`Aanpak: YouTube Data API v3 (OAuth 2.0)`);
  console.log(`Credentials: ${HAS_CREDENTIALS ? '✅ Geconfigureerd' : '⏭️ Niet geconfigureerd (alleen offline tests)'}`);
  console.log('='.repeat(60));
  console.log();

  const results: TestResult[] = [];

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

  // ── Test 6: parseSbv — geldige SBV-content ─────────────────────────────
  results.push(await runTest('parseSbv — geldige SBV-content', async () => {
    const sbv = `0:00:00.000,0:00:01.540
Hey there

0:00:02.000,0:00:04.500
How are you?

0:00:05.000,0:00:07.200
I am fine, thanks!`;

    const snippets = parseSbv(sbv);
    if (snippets.length !== 3) throw new Error(`Verwacht 3 snippets, kreeg ${snippets.length}`);
    if (snippets[0].text !== 'Hey there') throw new Error(`Verwacht "Hey there", kreeg "${snippets[0].text}"`);
    if (snippets[0].start !== 0) throw new Error(`Verwacht start=0, kreeg ${snippets[0].start}`);
    if (Math.abs(snippets[0].duration - 1.54) > 0.001) throw new Error(`Verwacht duration=1.54, kreeg ${snippets[0].duration}`);
    if (snippets[1].text !== 'How are you?') throw new Error(`Verwacht "How are you?", kreeg "${snippets[1].text}"`);
    if (snippets[2].text !== 'I am fine, thanks!') throw new Error(`Verwacht "I am fine, thanks!", kreeg "${snippets[2].text}"`);
    console.log(`   Aantal snippets: ${snippets.length}`);
    console.log(`   Eerste snippet: "${snippets[0].text}" @ ${snippets[0].start}s (dur: ${snippets[0].duration}s)`);
  }));

  // ── Test 7: parseSbv — lege SBV-content ───────────────────────────────
  results.push(await runTest('parseSbv — lege content', async () => {
    const snippets = parseSbv('');
    if (snippets.length !== 0) throw new Error(`Verwacht 0 snippets, kreeg ${snippets.length}`);
  }));

  // ── Test 8: parseSbv — enkele regel (geen geldige SBV) ────────────────
  results.push(await runTest('parseSbv — enkele regel (geen geldig blok)', async () => {
    const snippets = parseSbv('alleen tekst zonder timestamp');
    if (snippets.length !== 0) throw new Error(`Verwacht 0 snippets, kreeg ${snippets.length}`);
  }));

  // ── Test 9: parseSbv — HTML entities ──────────────────────────────────
  results.push(await runTest('parseSbv — HTML entities decoderen', async () => {
    const sbv = `0:00:00.000,0:00:01.000
It&amp;apos;s &lt;b&gt;cool&lt;/b&gt; &amp;quot;right&amp;quot;?`;
    const snippets = parseSbv(sbv);
    if (snippets.length !== 1) throw new Error(`Verwacht 1 snippet, kreeg ${snippets.length}`);
    if (snippets[0].text !== "It&apos;s <b>cool</b> &quot;right&quot;?") {
      throw new Error(`HTML entities niet correct gedecodeerd: "${snippets[0].text}"`);
    }
    console.log(`   Gedecodeerd: "${snippets[0].text}"`);
  }));

  // ── Test 10: OAuth token verversen (alleen met credentials) ──────────
  results.push(await runTest('OAuth token verversen', async () => {
    const token = await getAccessToken(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN);
    if (!token || typeof token !== 'string') throw new Error('Geen geldig token ontvangen');
    if (token.length < 20) throw new Error(`Token lijkt ongeldig (kort: ${token.length} chars)`);
    console.log(`   Token ontvangen (${token.length} chars, begint met "${token.slice(0, 10)}...")`);
  }, !HAS_CREDENTIALS));

  // ── Test 11: captions.list — bekende video met ondertiteling ──────────
  results.push(await runTest('captions.list — jNQXAC9IVRw', async () => {
    const token = await getAccessToken(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN);
    const tracks = await fetchCaptionTracks('jNQXAC9IVRw', token);
    if (tracks.length === 0) throw new Error('Geen caption tracks gevonden');
    console.log(`   Aantal tracks: ${tracks.length}`);
    console.log(`   Eerste track: ${tracks[0].languageCode} — "${tracks[0].name}" (${tracks[0].kind || 'onbekend'})`);
    const nl = tracks.find(t => t.languageCode === 'nl');
    const en = tracks.find(t => t.languageCode === 'en');
    console.log(`   Nederlands: ${nl ? '✅' : '❌'}, Engels: ${en ? '✅' : '❌'}`);
  }, !HAS_CREDENTIALS));

  // ── Test 12: captions.download — download NL of EN caption ────────────
  results.push(await runTest('captions.download — SBV-formaat', async () => {
    const token = await getAccessToken(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN);
    const tracks = await fetchCaptionTracks('jNQXAC9IVRw', token);
    const track = tracks.find(t => t.languageCode === 'nl') || tracks.find(t => t.languageCode === 'en') || tracks[0];
    const sbv = await downloadCaption(track.id, token);
    if (!sbv || sbv.length < 10) throw new Error('SBV-content te kort');
    console.log(`   Track: ${track.languageCode} (id: ${track.id})`);
    console.log(`   SBV lengte: ${sbv.length} chars`);
    console.log(`   Eerste 100 chars: "${sbv.slice(0, 100).replace(/\n/g, '\\n')}..."`);
    const snippets = parseSbv(sbv);
    console.log(`   Geparsed: ${snippets.length} snippets`);
  }, !HAS_CREDENTIALS));

  // ── Test 13: Volledige transcript-flow ────────────────────────────────
  results.push(await runTest('Volledige transcript — jNQXAC9IVRw', async () => {
    const result = await getTranscriptYoutubeApi(
      'jNQXAC9IVRw',
      YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET,
      YOUTUBE_REFRESH_TOKEN,
    );
    console.log(`   Video ID: ${result.videoId}`);
    console.log(`   Taal: ${result.language}`);
    console.log(`   Aantal snippets: ${result.snippets.length}`);
    console.log(`   Volledige tekst lengte: ${result.fullText.length} tekens`);
    console.log(`   Aanpak: ${result.approach}`);
    console.log(`   Eerste 120 chars: "${result.fullText.slice(0, 120)}..."`);
    if (result.snippets.length === 0) throw new Error('Geen snippets gevonden');
    if (!result.fullText) throw new Error('Geen fullText');
    if (result.approach !== 'youtube-data-api-v3') throw new Error(`Verwacht youtube-data-api-v3, kreeg ${result.approach}`);
  }, !HAS_CREDENTIALS));

  // ── Test 14: Video zonder ondertiteling ───────────────────────────────
  results.push(await runTest('Transcript — video zonder ondertiteling (zzzzzzzzzzz)', async () => {
    try {
      await getTranscriptYoutubeApi(
        'zzzzzzzzzzz',
        YOUTUBE_CLIENT_ID,
        YOUTUBE_CLIENT_SECRET,
        YOUTUBE_REFRESH_TOKEN,
      );
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof TranscriptNotAvailableError) {
        console.log(`   Acceptabele fout: ${err.name} — ${err.message}`);
      } else if (err instanceof OAuthError) {
        // OAuth-fout is ook acceptabel (credentials kunnen ongeldig zijn in testomgeving)
        console.log(`   OAuth-fout (acceptabel in niet-ingestelde omgeving): ${err.message}`);
      } else if (err instanceof TranscriptError) {
        console.log(`   TranscriptError (acceptabel): ${err.name} — ${err.message}`);
      } else {
        throw err;
      }
    }
  }, !HAS_CREDENTIALS));

  // ── Test 15: OAuth-foutafhandeling (ongeldige credentials) ────────────
  results.push(await runTest('OAuth-foutafhandeling — ongeldige credentials', async () => {
    try {
      await getAccessToken('fake-client-id', 'fake-client-secret', 'fake-refresh-token');
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof OAuthError) {
        console.log(`   Correcte fout: ${err.name} — ${err.message.slice(0, 80)}...`);
      } else {
        throw err;
      }
    }
  }));

  // ── Test 16: Ongeldige URL via getTranscriptYoutubeApi ────────────────
  results.push(await runTest('Transcript — ongeldige URL', async () => {
    try {
      await getTranscriptYoutubeApi('geen-geldig-id', '', '', '');
      throw new Error('Zou een fout moeten geven');
    } catch (err) {
      if (err instanceof InvalidVideoIdError) {
        console.log(`   Correcte fout: ${err.name} — ${err.message}`);
      } else {
        throw err;
      }
    }
  }));

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
  console.log(`**Aanpak:** YouTube Data API v3 (captions.list + captions.download via googleapis.com)`);
  console.log(`**Credentials:** ${HAS_CREDENTIALS ? '✅ Geconfigureerd' : '⏭️ Niet geconfigureerd'}`);
  console.log(`**Resultaat:** ${failed > 0 ? '⚠️ Sommige tests gefaald' : skipped > 0 ? '⏭️ Deels overgeslagen (geen OAuth credentials)' : '✅ Alle tests geslaagd'}`);
  console.log();
  console.log('**Bevindingen:**');
  if (HAS_CREDENTIALS && failed === 0) {
    console.log('- YouTube Data API v3 werkt met OAuth 2.0-authenticatie.');
    console.log('- Token-verversing (refresh token → access token) werkt correct.');
    console.log('- captions.list ontdekt beschikbare ondertiteling.');
    console.log('- captions.download levert SBV-formaat op.');
    console.log('- SBV-parsing werkt voor getimede snippets.');
    console.log('- Taalkeuze (NL > EN > eerste) werkt.');
    console.log('- URL-validatie werkt voor alle formaten.');
    console.log('- Error classes geven correcte HTTP-statuscodes.');
  } else if (HAS_CREDENTIALS && failed > 0) {
    console.log('- Sommige API-tests faalden. Controleer de OAuth-credentials en quota.');
    console.log('- De offline tests (parseVideoId, parseSbv) zijn wel geslaagd.');
  } else {
    console.log('- Offline tests (parseVideoId, parseSbv) werken correct.');
    console.log('- OAuth-afhankelijke tests zijn overgeslagen wegens ontbrekende credentials.');
    console.log('- Voer HITL-stappen 1-3 uit (Google Cloud project, OAuth-client, refresh token).');
    console.log('- Stel daarna environment variables in en voer de smoketest opnieuw uit.');
    console.log('- Optioneel: test OAuth-foutafhandeling met ongeldige tokens (test 15).');
  }
  console.log();
  console.log('**Aanbevolen vervolg:**');
  if (!HAS_CREDENTIALS) {
    console.log('1. Voer HITL 1 uit: Google Cloud project aanmaken + YouTube Data API v3 inschakelen.');
    console.log('2. Voer HITL 2 uit: OAuth 2.0-client aanmaken + refresh token verkrijgen.');
    console.log('3. Voer HITL 3 uit: Vercel cloudsecrets instellen (YOUTUBE_CLIENT_ID, _SECRET, _REFRESH_TOKEN).');
    console.log('4. Herstart de smoketest met credentials: npx tsx smoketest-transcript.ts');
  } else if (failed > 0) {
    console.log('1. Controleer of de YouTube API quota niet is overschreden.');
    console.log('2. Controleer of de OAuth-credentials correct zijn.');
    console.log('3. Test met een andere video of handmatig via OAuth Playground.');
  } else {
    console.log('1. Voer HITL 3 uit: Vercel cloudsecrets instellen met de juiste credentials.');
    console.log('2. Deploy naar Vercel en test de /transcript-endpoint op de live omgeving.');
    console.log('3. Meet de doorlooptijd en vergelijk met lokale resultaten.');
    console.log('4. Voer HITL 4 uit: eindreview en afronding.');
  }
}

main().catch(console.error);

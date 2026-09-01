/**
 * MTG Price Oracle - Daily Price Tracker v4.0
 *
 * ONE query: usd>=0.50, pages through all results.
 * Firestore batch writes with delays between batches to avoid quota spikes.
 *
 * v4.0: History is keyed by oracle_id, in a new `cardHistory` collection.
 *   Scryfall's unique=cards hands back the CHEAPEST printing of each
 *   card, so what is tracked is a card's market floor. Which printing
 *   supplies that floor moves whenever a cheaper reprint releases, and
 *   keyed by printing id that silently ended one series and started
 *   another with no history -- the reprint looked like a card with no
 *   past instead of a price drop. oracle_id is identical across every
 *   printing of a card, forever. Each snapshot now also carries `set`,
 *   which is what makes a step in the line legible as a reprint.
 *
 *   The old printing-keyed `priceHistory` is left untouched; the
 *   frontend falls back to it until a card's oracle series is long
 *   enough to chart.
 *
 * v3.0: Halved the daily write cost and made the run idempotent.
 *   - Meta docs (priceHistory/{id}) were rewritten every day for every
 *     card: ~7,600 writes, an exact half of the 20k/day free tier, for
 *     fields that never change (name/set/setName/rarity) and that
 *     nothing in the app ever reads — the UI only queries the snapshots
 *     subcollection. Now written once, for cards we have not seen before.
 *     Finding out which those are costs reads, but reads are a separate
 *     and larger quota (50k/day), so it is a good trade.
 *   - A run marker (meta/lastRun) makes re-runs cheap no-ops, so the
 *     workflow can schedule backstop attempts without doubling writes.
 *     GitHub delays scheduled jobs by hours under load and sometimes
 *     drops them, so one fixed daily attempt is not reliable.
 *
 * v2.2: Added 1s delay between Firebase batches to avoid RESOURCE_EXHAUSTED.
 *        Smaller batch size (200 ops) for smoother writes.
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ====== CONFIG ======
const MIN_PRICE = 0.50;
const SCRYFALL_DELAY = 110;
const BATCH_SIZE = 200;          // Reduced from 500 — gentler on Firebase
const BATCH_PAUSE = 1500;        // 1.5s pause between batches
const MAX_RETRIES = 3;
// Set FORCE_RUN=1 to rewrite a day that has already been recorded.
const FORCE_RUN = process.env.FORCE_RUN === '1';
// Collection keyed by oracle_id. The old printing-id-keyed `priceHistory`
// is left in place: the frontend still falls back to it for cards whose
// oracle series has not accumulated enough days yet.
const HISTORY = 'cardHistory';

// ====== SCRYFALL FETCHER ======
let lastRequest = 0;
let totalApiCalls = 0;

async function scryfallFetch(url, retries = 0) {
  const now = Date.now();
  const wait = SCRYFALL_DELAY - (now - lastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();
  totalApiCalls++;

  try {
    const response = await fetch(url);
    if (response.status === 429) {
      const backoff = Math.pow(2, retries + 1) * 1000;
      console.warn(`  Rate limited! Waiting ${backoff/1000}s...`);
      await new Promise(r => setTimeout(r, backoff));
      if (retries < MAX_RETRIES) return scryfallFetch(url, retries + 1);
      throw new Error('Rate limited after max retries');
    }
    if (!response.ok) throw new Error(`Scryfall HTTP ${response.status}`);
    return response.json();
  } catch (e) {
    if (retries < MAX_RETRIES) {
      console.warn(`  Error: ${e.message}. Retry ${retries + 1}/${MAX_RETRIES}...`);
      await new Promise(r => setTimeout(r, 2000));
      return scryfallFetch(url, retries + 1);
    }
    throw e;
  }
}

// ====== MAIN ======
async function main() {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  
  console.log('=== MTG Price Oracle - Daily Price Tracker v3.0 ===');
  console.log(`Date: ${today}`);
  console.log(`Min price: $${MIN_PRICE}`);
  console.log(`Batch size: ${BATCH_SIZE} ops, ${BATCH_PAUSE}ms pause between`);
  console.log('');

  // STEP 0: Has today already been recorded?
  // The workflow schedules several attempts because GitHub delays cron
  // jobs by hours under load and sometimes skips them outright. This
  // marker makes every attempt after the first a two-read no-op instead
  // of a second full pass over the write quota.
  const runMarkerRef = db.collection('meta').doc('lastRun');
  if (!FORCE_RUN) {
    try {
      const marker = await runMarkerRef.get();
      if (marker.exists && marker.data().date === today) {
        console.log(`Today (${today}) was already recorded at ${marker.data().finishedAt}.`);
        console.log('Nothing to do. Set FORCE_RUN=1 to rewrite it.');
        process.exit(0);
      }
    } catch (e) {
      console.warn(`  Could not read run marker (${e.message}) — continuing.`);
    }
  }

  // STEP 1: Fetch all cards with usd >= $0.50
  console.log('Step 1: Fetching all priced cards from Scryfall...');
  
  const allCards = [];
  const seenIds = new Set();
  let droppedNoOracleId = 0;
  let pageUrl = `https://api.scryfall.com/cards/search?q=usd>=${MIN_PRICE}&order=usd&dir=desc`;
  let pageNum = 0;
  let totalCards = null;

  while (pageUrl) {
    pageNum++;
    try {
      const data = await scryfallFetch(pageUrl);
      if (pageNum === 1) {
        totalCards = data.total_cards;
        console.log(`  Scryfall reports ${totalCards} total cards`);
      }

      for (const card of data.data) {
        // Dropped here rather than at write time: oracle_id is the
        // document key, and the meta lookup below builds refs from it
        // before the write loop ever runs. A card without one would
        // throw on doc(undefined). Scryfall always sends it, so this
        // guards a malformed response, not an expected case.
        if (!card.oracle_id) { droppedNoOracleId++; continue; }
        // Dedupe on oracle_id, since that is now the document key. With
        // unique=cards these should already be distinct; a duplicate here
        // would mean two writes to the same document in one batch, which
        // Firestore rejects outright.
        if (!seenIds.has(card.oracle_id)) {
          seenIds.add(card.oracle_id);
          allCards.push(card);
        }
      }

      if (pageNum % 5 === 0 || !data.has_more) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = totalCards ? ((allCards.length / totalCards) * 100).toFixed(0) : '?';
        console.log(`  Page ${pageNum}: ${allCards.length} cards (${pct}%) — ${elapsed}s`);
      }

      pageUrl = data.has_more ? data.next_page : null;
    } catch (e) {
      console.error(`  Error on page ${pageNum}: ${e.message}`);
      break;
    }
  }

  console.log(`\n  Total: ${allCards.length} unique cards, ${pageNum} pages, ${totalApiCalls} API calls`);
  if (droppedNoOracleId) {
    console.warn(`  ${droppedNoOracleId} rows had no oracle_id and were dropped.`);
  }

  if (!allCards.length) {
    console.error('No cards fetched! Aborting.');
    process.exit(1);
  }

  // STEP 2: Batch write to Firestore with pacing
  console.log(`\nStep 2: Writing ${allCards.length} snapshots to Firebase (with pacing)...`);
  
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batchNum = 0;
  let metaWrites = 0;
  let snapshotWrites = 0;

  // Which cards already have a meta doc? The meta doc holds only fields
  // that never change for a card id, and nothing in the app reads it —
  // the UI queries the snapshots subcollection directly. Rewriting it
  // daily was burning half the write quota, so fetch the ids once and
  // write meta only for cards we have not seen. select() with no fields
  // returns refs only, so this is cheap in bandwidth; it still costs one
  // read per document, but reads have a separate 50k/day allowance
  // against writes' 20k.
  // Look up only the cards in this run, not the whole collection.
  // Scanning it cost 24,638 reads (49% of the daily allowance) because
  // priceHistory has accumulated far more documents than the ~7,700
  // cards currently over the price floor — and that gap only widens.
  // getAll on the exact refs is bounded by the run size instead.
  const knownMeta = new Set();
  let metaReads = 0;
  const GET_ALL_CHUNK = 300;
  try {
    for (let i = 0; i < allCards.length; i += GET_ALL_CHUNK) {
      const refs = allCards.slice(i, i + GET_ALL_CHUNK)
        .map(c => db.collection(HISTORY).doc(c.oracle_id));
      const docs = await db.getAll(...refs);
      metaReads += refs.length; // a miss is still billed as a read
      docs.forEach(d => { if (d.exists) knownMeta.add(d.id); });
    }
    console.log(`  ${knownMeta.size}/${allCards.length} cards already have a meta doc (${metaReads} reads)`);
  } catch (e) {
    // On failure, fall back to writing meta for everything — correct,
    // just as expensive as the old behaviour.
    console.warn(`  Could not check existing meta docs (${e.message}) — writing all.`);
  }

  // Ops per card is 1 (snapshot) or 2 (snapshot + first-time meta), so
  // chunk by counting real ops rather than assuming the worst case.
  const chunkSize = BATCH_SIZE;

  for (let i = 0; i < allCards.length; i += chunkSize) {
    batchNum++;
    const chunk = allCards.slice(i, i + chunkSize);
    const batch = db.batch();
    let batchCount = 0;
    let batchOps = 0;

    for (const card of chunk) {
      const usd = parseFloat(card.prices?.usd) || null;
      const usdFoil = parseFloat(card.prices?.usd_foil) || null;
      const eur = parseFloat(card.prices?.eur) || null;

      if (!usd && !usdFoil) { totalSkipped++; continue; }

      // Keyed by oracle_id, not by printing id. Scryfall hands back the
      // CHEAPEST printing of each card, so the series is a card's market
      // floor -- but which printing supplies that floor moves whenever a
      // cheaper reprint releases. Keyed by printing, that silently ended
      // one series and began another with no history: Sol Ring's Marvel
      // printing has nothing before 2026-07-01 because that is when it
      // became the cheapest one, and the years before it live under a
      // different id. oracle_id is the same on every printing of a card,
      // forever, so the series stays continuous and a reprint reads as
      // what it is -- a price drop, with the set that caused it named.
      const snapshotRef = db.collection(HISTORY).doc(card.oracle_id)
        .collection('snapshots').doc(today);
      // No name/set here. They never change for a card id, they are
      // already on the meta doc, and repeating them in every daily
      // snapshot cost 30 bytes plus four index entries per card per
      // day — about a fifth of the collection's storage for two fields
      // nothing reads out of a snapshot.
      // `set` earns its 9 bytes here: it is what makes a step in the line
      // legible as a reprint rather than an unexplained crash.
      batch.set(snapshotRef, { usd, usd_foil: usdFoil, eur, set: card.set });
      batchOps++;

      if (!knownMeta.has(card.oracle_id)) {
        const metaRef = db.collection(HISTORY).doc(card.oracle_id);
        batch.set(metaRef, {
          name: card.name, set: card.set, setName: card.set_name || '',
          rarity: card.rarity || ''
        }, { merge: true });
        knownMeta.add(card.oracle_id);
        batchOps++;
      }

      batchCount++;
    }

    if (batchCount > 0) {
      try {
        await batch.commit();
        totalWritten += batchCount;
        snapshotWrites += batchCount;
        metaWrites += batchOps - batchCount;
      } catch (e) {
        totalErrors += batchCount;
        console.error(`  Batch ${batchNum} FAILED: ${e.message}`);
        
        // If quota exhausted, stop — no point continuing
        if (e.message.includes('RESOURCE_EXHAUSTED') || e.message.includes('Quota')) {
          console.error('\n  *** FIREBASE QUOTA EXHAUSTED ***');
          console.error('  Stopping writes. Quota resets at midnight Pacific time.');
          console.error(`  Successfully wrote ${totalWritten} cards before quota hit.`);
          break;
        }
      }
    }

    // Progress log
    if (batchNum % 10 === 0 || i + chunkSize >= allCards.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = Math.min(((i + chunkSize) / allCards.length * 100), 100).toFixed(0);
      console.log(`  Batch ${batchNum}: ${totalWritten} written (${pct}%) — ${elapsed}s`);
    }

    // Pause between batches to avoid quota spikes
    if (i + chunkSize < allCards.length) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
  }

  // STEP 3: Mark the day done, so later scheduled attempts no-op
  const writeCount = snapshotWrites + metaWrites + 1; // +1 for this marker
  if (totalWritten > 0 && totalErrors === 0) {
    try {
      await runMarkerRef.set({
        date: today,
        finishedAt: new Date().toISOString(),
        cards: totalWritten,
        writes: writeCount
      });
    } catch (e) {
      // Not fatal: the prices are already stored. A later attempt will
      // simply redo the day rather than skipping it.
      console.warn(`  Could not write run marker: ${e.message}`);
    }
  } else if (totalErrors > 0) {
    console.warn('  Errors occurred — leaving the day unmarked so a later run retries.');
  }

  // STEP 4: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const minutes = (elapsed / 60).toFixed(1);

  console.log('\n========================================');
  console.log('=== Run Complete ===');
  console.log('========================================');
  console.log(`Date:             ${today}`);
  console.log(`Cards fetched:    ${allCards.length}`);
  console.log(`Prices written:   ${totalWritten}`);
  console.log(`Skipped (no $):   ${totalSkipped}`);
  console.log(`Errors:           ${totalErrors}`);
  console.log(`Scryfall pages:   ${pageNum}`);
  console.log(`Firebase batches: ${batchNum}`);
  console.log(`  snapshot writes: ${snapshotWrites}`);
  console.log(`  meta writes:     ${metaWrites} (new cards only)`);
  console.log(`Firebase writes:  ~${writeCount} (${(writeCount / 20000 * 100).toFixed(0)}% of free tier)`);
  console.log(`Firebase reads:   ~${metaReads} (${(metaReads / 50000 * 100).toFixed(0)}% of free tier)`);
  console.log(`Total time:       ${minutes} min (${elapsed}s)`);
  console.log('========================================');

  const ranges = { '$0.50-$1': 0, '$1-$5': 0, '$5-$20': 0, '$20-$50': 0, '$50+': 0 };
  allCards.forEach(c => {
    const p = parseFloat(c.prices?.usd) || 0;
    if (p >= 50) ranges['$50+']++;
    else if (p >= 20) ranges['$20-$50']++;
    else if (p >= 5) ranges['$5-$20']++;
    else if (p >= 1) ranges['$1-$5']++;
    else ranges['$0.50-$1']++;
  });
  console.log('\nPrice distribution:');
  Object.entries(ranges).forEach(([r, c]) => console.log(`  ${r}: ${c} cards`));

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

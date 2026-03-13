/**
 * MTG Price Oracle - Daily Price Tracker v2.1
 * 
 * ONE query: usd>=0.50, unique=cards (one per card name, cheapest printing)
 * Firestore batch writes. Runs once daily.
 *
 * v2.1 fixes: removed unique=prints (was returning 25K+ results),
 * increased timeout, added progress ETA
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
const BATCH_SIZE = 500;
const MAX_RETRIES = 3;

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
  
  console.log('=== MTG Price Oracle - Daily Price Tracker v2.1 ===');
  console.log(`Date: ${today}`);
  console.log(`Min price: $${MIN_PRICE}`);
  console.log('');

  // STEP 1: Fetch all cards with usd >= $0.50 (unique=cards = one per card name)
  console.log('Step 1: Fetching all priced cards from Scryfall...');
  
  const allCards = [];
  const seenIds = new Set();
  let pageUrl = `https://api.scryfall.com/cards/search?q=usd>=${MIN_PRICE}&order=usd&dir=desc`;
  let pageNum = 0;
  let totalCards = null;

  while (pageUrl) {
    pageNum++;
    try {
      const data = await scryfallFetch(pageUrl);
      if (pageNum === 1) {
        totalCards = data.total_cards;
        console.log(`  Scryfall reports ${totalCards} total cards matching query`);
      }

      for (const card of data.data) {
        if (!seenIds.has(card.id)) {
          seenIds.add(card.id);
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

  console.log(`\n  Fetched ${allCards.length} unique cards across ${pageNum} pages`);
  console.log(`  Scryfall API calls: ${totalApiCalls}`);

  if (!allCards.length) {
    console.error('No cards fetched! Aborting.');
    process.exit(1);
  }

  // STEP 2: Batch write to Firestore
  console.log(`\nStep 2: Writing ${allCards.length} snapshots to Firebase...`);
  
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batchNum = 0;

  // Each card = 2 writes, so chunk at BATCH_SIZE/2
  const chunkSize = Math.floor(BATCH_SIZE / 2);
  
  for (let i = 0; i < allCards.length; i += chunkSize) {
    batchNum++;
    const chunk = allCards.slice(i, i + chunkSize);
    const batch = db.batch();
    let batchCount = 0;

    for (const card of chunk) {
      const usd = parseFloat(card.prices?.usd) || null;
      const usdFoil = parseFloat(card.prices?.usd_foil) || null;
      const eur = parseFloat(card.prices?.eur) || null;

      if (!usd && !usdFoil) { totalSkipped++; continue; }

      const snapshotRef = db.collection('priceHistory').doc(card.id)
        .collection('snapshots').doc(today);
      batch.set(snapshotRef, { usd, usd_foil: usdFoil, eur, name: card.name, set: card.set });

      const metaRef = db.collection('priceHistory').doc(card.id);
      batch.set(metaRef, {
        name: card.name, set: card.set, setName: card.set_name || '',
        rarity: card.rarity || '', lastUpdated: today
      }, { merge: true });

      batchCount++;
    }

    if (batchCount > 0) {
      try {
        await batch.commit();
        totalWritten += batchCount;
      } catch (e) {
        totalErrors += batchCount;
        console.error(`  Batch ${batchNum} FAILED: ${e.message}`);
      }
    }

    if (batchNum % 5 === 0 || i + chunkSize >= allCards.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = ((i + chunkSize) / allCards.length * 100).toFixed(0);
      console.log(`  Batch ${batchNum}: ${totalWritten} written (${Math.min(pct,100)}%) — ${elapsed}s`);
    }
  }

  // STEP 3: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const minutes = (elapsed / 60).toFixed(1);
  const writeCount = totalWritten * 2;

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
  console.log(`Firebase writes:  ~${writeCount} (${(writeCount / 20000 * 100).toFixed(0)}% of free tier)`);
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

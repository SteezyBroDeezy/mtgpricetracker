/**
 * MTG Price Oracle - Daily Price Tracker v2
 * 
 * STRATEGY: One single Scryfall query (usd>=0.50) pages through ALL priced cards.
 * Deduplication is automatic. Firestore batch writes (500/batch) instead of individual writes.
 * Runs once daily — Scryfall prices only update once per day anyway.
 *
 * Expected: ~7,000-9,000 unique cards, ~45 Scryfall pages, ~36 Firestore batches
 * Runtime: ~5-8 minutes (vs 6 hours with the old script)
 * Firebase writes: ~16,000/day (well under 20,000 free tier limit)
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ====== CONFIG ======
const MIN_PRICE = 0.50;          // Track cards worth $0.50+
const SCRYFALL_DELAY = 110;      // ms between requests (Scryfall asks for 100ms)
const BATCH_SIZE = 500;          // Firestore max batch size
const MAX_RETRIES = 3;           // Retry failed Scryfall pages

// ====== SCRYFALL FETCHER ======
let lastRequest = 0;
let totalApiCalls = 0;

async function scryfallFetch(url, retries = 0) {
  // Rate limit
  const now = Date.now();
  const wait = SCRYFALL_DELAY - (now - lastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();
  totalApiCalls++;

  try {
    const response = await fetch(url);
    
    if (response.status === 429) {
      // Rate limited — back off and retry
      const backoff = Math.pow(2, retries + 1) * 1000;
      console.warn(`  Rate limited! Waiting ${backoff/1000}s before retry...`);
      await new Promise(r => setTimeout(r, backoff));
      if (retries < MAX_RETRIES) return scryfallFetch(url, retries + 1);
      throw new Error('Rate limited after max retries');
    }
    
    if (!response.ok) throw new Error(`Scryfall HTTP ${response.status}`);
    return response.json();
  } catch (e) {
    if (retries < MAX_RETRIES) {
      console.warn(`  Fetch error: ${e.message}. Retry ${retries + 1}/${MAX_RETRIES}...`);
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
  
  console.log('=== MTG Price Oracle - Daily Price Tracker v2 ===');
  console.log(`Date: ${today}`);
  console.log(`Min price: $${MIN_PRICE}`);
  console.log('');

  // ====== STEP 1: Fetch ALL cards with USD price >= $0.50 ======
  console.log('Step 1: Fetching all priced cards from Scryfall...');
  
  const allCards = [];
  const seenIds = new Set();
  let pageUrl = `https://api.scryfall.com/cards/search?q=usd>=${MIN_PRICE}&order=usd&dir=desc&unique=prints`;
  let pageNum = 0;

  while (pageUrl) {
    pageNum++;
    try {
      const data = await scryfallFetch(pageUrl);
      
      // Deduplicate (shouldn't be needed with unique=prints but safety first)
      for (const card of data.data) {
        if (!seenIds.has(card.id)) {
          seenIds.add(card.id);
          allCards.push(card);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (pageNum % 10 === 0 || !data.has_more) {
        console.log(`  Page ${pageNum}: ${allCards.length} unique cards so far (${elapsed}s)`);
      }

      pageUrl = data.has_more ? data.next_page : null;
    } catch (e) {
      console.error(`  Error on page ${pageNum}: ${e.message}`);
      // Try to continue with next page if possible
      break;
    }
  }

  console.log(`\nFetched ${allCards.length} unique cards across ${pageNum} pages`);
  console.log(`Scryfall API calls: ${totalApiCalls}`);

  if (!allCards.length) {
    console.error('No cards fetched! Aborting.');
    process.exit(1);
  }

  // ====== STEP 2: Batch write to Firestore ======
  console.log(`\nStep 2: Writing ${allCards.length} price snapshots to Firebase...`);
  
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batchNum = 0;

  // Process in chunks of BATCH_SIZE/2 (each card = 2 writes: snapshot + metadata)
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

      if (!usd && !usdFoil) {
        totalSkipped++;
        continue;
      }

      // Snapshot document (priceHistory/{cardId}/snapshots/{date})
      const snapshotRef = db.collection('priceHistory').doc(card.id)
        .collection('snapshots').doc(today);
      batch.set(snapshotRef, {
        usd,
        usd_foil: usdFoil,
        eur,
        name: card.name,
        set: card.set
      });

      // Metadata document (priceHistory/{cardId})
      const metaRef = db.collection('priceHistory').doc(card.id);
      batch.set(metaRef, {
        name: card.name,
        set: card.set,
        setName: card.set_name || '',
        rarity: card.rarity || '',
        lastUpdated: today
      }, { merge: true });

      batchCount++;
    }

    if (batchCount > 0) {
      try {
        await batch.commit();
        totalWritten += batchCount;
        
        if (batchNum % 5 === 0 || i + chunkSize >= allCards.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const pct = ((i + chunkSize) / allCards.length * 100).toFixed(0);
          console.log(`  Batch ${batchNum}: ${totalWritten} written (${pct}%, ${elapsed}s)`);
        }
      } catch (e) {
        totalErrors += batchCount;
        console.error(`  Batch ${batchNum} FAILED: ${e.message}`);
        
        // If batch fails, try individual writes as fallback
        console.log(`  Retrying batch ${batchNum} as individual writes...`);
        for (const card of chunk) {
          const usd = parseFloat(card.prices?.usd) || null;
          const usdFoil = parseFloat(card.prices?.usd_foil) || null;
          if (!usd && !usdFoil) continue;
          
          try {
            await db.collection('priceHistory').doc(card.id)
              .collection('snapshots').doc(today).set({
                usd,
                usd_foil: usdFoil,
                eur: parseFloat(card.prices?.eur) || null,
                name: card.name,
                set: card.set
              });
            await db.collection('priceHistory').doc(card.id).set({
              name: card.name,
              set: card.set,
              setName: card.set_name || '',
              rarity: card.rarity || '',
              lastUpdated: today
            }, { merge: true });
            totalErrors--;
            totalWritten++;
          } catch (e2) {
            // Skip this card
          }
        }
      }
    }
  }

  // ====== STEP 3: Summary ======
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const minutes = (elapsed / 60).toFixed(1);

  console.log('\n========================================');
  console.log('=== MTG Price Oracle - Run Complete ===');
  console.log('========================================');
  console.log(`Date:            ${today}`);
  console.log(`Cards fetched:   ${allCards.length}`);
  console.log(`Prices written:  ${totalWritten}`);
  console.log(`Skipped (no $):  ${totalSkipped}`);
  console.log(`Errors:          ${totalErrors}`);
  console.log(`Scryfall calls:  ${totalApiCalls}`);
  console.log(`Firebase batches:${batchNum}`);
  console.log(`Total time:      ${minutes} minutes (${elapsed}s)`);
  console.log(`Est. daily writes: ${totalWritten * 2} (${(totalWritten * 2 / 20000 * 100).toFixed(0)}% of free tier)`);
  console.log('========================================');

  // Price distribution summary
  const priceRanges = { '$0.50-$1': 0, '$1-$5': 0, '$5-$20': 0, '$20-$50': 0, '$50+': 0 };
  allCards.forEach(c => {
    const p = parseFloat(c.prices?.usd) || 0;
    if (p >= 50) priceRanges['$50+']++;
    else if (p >= 20) priceRanges['$20-$50']++;
    else if (p >= 5) priceRanges['$5-$20']++;
    else if (p >= 1) priceRanges['$1-$5']++;
    else priceRanges['$0.50-$1']++;
  });
  console.log('\nPrice distribution:');
  Object.entries(priceRanges).forEach(([range, count]) => {
    console.log(`  ${range}: ${count} cards`);
  });

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

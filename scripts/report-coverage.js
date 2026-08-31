/**
 * MTG Price Oracle - Coverage report
 *
 * Answers "is my data actually being collected?" without opening the
 * site, which matters because the site itself is not the source of
 * truth: a frontend bug can hide perfectly good data, and that is
 * exactly what happened in August 2026.
 *
 * There is no watchlist to configure. track-prices.js records every
 * card Scryfall prices at or above $0.50, every day, whether or not
 * anyone visits. So the useful questions are "did the run happen" and
 * "does this particular card have a fresh snapshot", and this reports
 * both.
 *
 *   node scripts/report-coverage.js                 # overall health
 *   node scripts/report-coverage.js "Sol Ring" ...  # plus named cards
 *
 * Named cards are resolved through Scryfall, so the exact printing
 * checked is the one Scryfall treats as canonical. Prices are tracked
 * per printing, and a card can have dozens.
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldPath } = admin.firestore;

const SAMPLE = 40;   // random-ish cards checked for the freshness estimate
const WINDOW = 14;   // days of recent history summarised per card

function isoDate(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

async function scryfallId(name) {
  const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const card = await res.json();
  return { id: card.id, set: card.set, name: card.name, price: card.prices?.usd || null };
}

async function coverage(cardId, since) {
  const snaps = await db.collection('priceHistory').doc(cardId).collection('snapshots')
    .where(FieldPath.documentId(), '>=', since)
    .orderBy(FieldPath.documentId())
    .get();
  return snaps.docs.map(d => ({ date: d.id, usd: d.get('usd') }));
}

async function main() {
  const today = isoDate(new Date());
  const since = daysAgo(WINDOW);

  console.log('=== MTG Price Oracle - Coverage Report ===');
  console.log(`Today: ${today}   Window: last ${WINDOW} days (from ${since})\n`);

  // 1. Did the tracker run?
  const marker = await db.collection('meta').doc('lastRun').get();
  if (!marker.exists) {
    console.log('meta/lastRun is missing — the tracker has never completed a run.');
  } else {
    const m = marker.data();
    const lag = Math.round((new Date(today) - new Date(m.date)) / 86400000);
    const verdict = lag === 0 ? 'current' : lag === 1 ? 'one day behind' : `STALE by ${lag} days`;
    console.log(`Last completed run: ${m.date} (${verdict})`);
    console.log(`  finished ${m.finishedAt}, ${m.cards} cards, ~${m.writes} writes\n`);
  }

  // 2. Is the tail of the price range being reached? A run that dies on
  //    quota partway through still looks like a success in the Actions
  //    log, and the cards it drops are always the cheap ones, because
  //    the tracker pages Scryfall in descending price order.
  console.log(`Sampling ${SAMPLE} tracked cards across the price range...`);
  const sample = await db.collection('priceHistory').limit(SAMPLE).get();
  let fresh = 0, stale = 0, empty = 0;
  const staleExamples = [];
  for (const doc of sample.docs) {
    const rows = await coverage(doc.id, since);
    if (!rows.length) { empty++; continue; }
    const last = rows[rows.length - 1].date;
    if (last === today || last === daysAgo(1)) fresh++;
    else {
      stale++;
      if (staleExamples.length < 5) staleExamples.push(`${doc.get('name') || doc.id} (last ${last})`);
    }
  }
  console.log(`  fresh: ${fresh}   stale: ${stale}   no recent data: ${empty}`);
  if (staleExamples.length) {
    console.log('  examples of stale cards:');
    staleExamples.forEach(s => console.log(`    ${s}`));
  }
  if (empty > SAMPLE / 2) {
    console.log('  NOTE: most sampled cards have no recent snapshots. The collection');
    console.log('  holds cards the browser recorded once that are now below the $0.50');
    console.log('  floor, so some of this is expected — but a majority is not.');
  }
  console.log('');

  // 3. Named cards, if any were asked for.
  const names = process.argv.slice(2);
  if (!names.length) {
    console.log('Pass card names to check them individually, e.g.:');
    console.log('  node scripts/report-coverage.js "Sol Ring" "Ragavan, Nimble Pilferer"');
    process.exit(0);
  }

  console.log('Named cards:');
  for (const name of names) {
    const card = await scryfallId(name);
    if (!card) { console.log(`  ${name}: not found on Scryfall`); continue; }
    const rows = await coverage(card.id, since);
    const days = rows.map(r => r.date);
    const missing = [];
    for (let i = WINDOW; i >= 0; i--) {
      const d = daysAgo(i);
      if (!days.includes(d)) missing.push(d);
    }
    console.log(`  ${card.name} [${card.set}] $${card.price ?? '-'}`);
    console.log(`    ${rows.length}/${WINDOW + 1} days present` +
      (missing.length ? `, missing ${missing.length}: ${missing.slice(0, 6).join(' ')}${missing.length > 6 ? ' ...' : ''}` : ''));
    if (rows.length) {
      const first = rows[0], last = rows[rows.length - 1];
      console.log(`    ${first.date} $${first.usd} -> ${last.date} $${last.usd}`);
    }
    if (card.price !== null && parseFloat(card.price) < 0.50) {
      console.log('    below the $0.50 tracking floor — gaps here are by design');
    }
    await new Promise(r => setTimeout(r, 120)); // Scryfall rate limit
  }

  process.exit(0);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });

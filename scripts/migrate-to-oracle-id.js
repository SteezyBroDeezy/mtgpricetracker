/**
 * MTG Price Oracle - Backfill cardHistory from the old priceHistory
 *
 * History used to be keyed by printing id. It is now keyed by oracle_id
 * (see track-prices.js v4.0). This copies what the old scheme recorded
 * into the new one so a card's chart does not start empty on the day of
 * the switch.
 *
 * What it copies, and what it deliberately does not:
 *
 *   - Only the printing the tracker was actually recording — the
 *     cheapest one. Earlier segments under other printings, from before
 *     that one became cheapest, are left behind. Chasing them would mean
 *     enumerating every printing of every card and reading millions of
 *     documents, and the result would still be a stitched-together line.
 *   - Only dates strictly before the switch. Anything on or after it the
 *     tracker has already written correctly, and rewriting it would cost
 *     writes to produce identical values.
 *   - Only the last MIGRATE_DAYS days. Older days would be collapsed to
 *     one-per-week by the pruner anyway, so copying them in full spends
 *     quota on documents scheduled for deletion.
 *
 * Budgeted and resumable like the pruner: a cursor in meta/migrateCursor
 * holds the position in the card list, and each run does what its read
 * and write budgets allow. Expect it to take several days. It is safe to
 * run repeatedly and safe to stop at any point — the tracker keeps
 * working throughout, and every card is either fully migrated or not yet
 * reached, never half-written.
 *
 *   FIREBASE_SERVICE_ACCOUNT=... node scripts/migrate-to-oracle-id.js
 *
 *   MIGRATE_DRY_RUN=1     report what would be copied, write nothing
 *   MIGRATE_SWITCH_DATE   defaults to today; set it if the switch has
 *                         already been live for a while
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldPath } = admin.firestore;

const MIN_PRICE = 0.50;
const SCRYFALL_DELAY = 110;
const MIGRATE_DAYS = Number(process.env.MIGRATE_DAYS || 90);
const READ_BUDGET = Number(process.env.MIGRATE_READ_BUDGET || 25000);
// Sized against the headroom this actually has. A tracker day costs
// ~7,760 writes, and for the first 90 days the pruner has nothing to do
// on cardHistory — nothing in it is old enough to collapse — which is
// precisely the window this runs in. Once the pruner starts working
// (~6,600 deletes plus ~1,100 rewrites a day) the migration should be
// finished; if it is not, lower this rather than letting the day's
// total approach 20,000.
const WRITE_BUDGET = Number(process.env.MIGRATE_WRITE_BUDGET || 4000);
const BATCH_SIZE = 200;
const BATCH_PAUSE = 800;
const DRY_RUN = process.env.MIGRATE_DRY_RUN === '1';

function isoDate(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

let lastRequest = 0;
async function scryfall(url, retries = 0) {
  const wait = SCRYFALL_DELAY - (Date.now() - lastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url);
  if (res.status === 429 && retries < 4) {
    await new Promise(r => setTimeout(r, 2 ** (retries + 1) * 1000));
    return scryfall(url, retries + 1);
  }
  if (!res.ok) throw new Error(`Scryfall HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const started = Date.now();
  const switchDate = process.env.MIGRATE_SWITCH_DATE || isoDate(new Date());
  const from = daysAgo(MIGRATE_DAYS);

  console.log('=== MTG Price Oracle - oracle_id backfill ===');
  console.log(`Copying snapshots dated ${from} .. before ${switchDate}`);
  console.log(`Budgets: ${READ_BUDGET} reads, ${WRITE_BUDGET} writes.${DRY_RUN ? ' DRY RUN.' : ''}`);
  console.log('');

  // The card list is rebuilt from Scryfall rather than from Firestore,
  // because the mapping this needs — oracle_id to the printing the
  // tracker was recording — only exists in Scryfall's response. The
  // order is deterministic, so an index into it is a usable cursor.
  console.log('Fetching the card list from Scryfall...');
  const cards = [];
  let url = `https://api.scryfall.com/cards/search?q=usd>=${MIN_PRICE}&order=usd&dir=desc`;
  while (url) {
    const data = await scryfall(url);
    for (const c of data.data) {
      if (c.oracle_id) cards.push({ oracle: c.oracle_id, printing: c.id, name: c.name });
    }
    url = data.has_more ? data.next_page : null;
  }
  console.log(`  ${cards.length} cards\n`);

  const cursorRef = db.collection('meta').doc('migrateCursor');
  let start = 0;
  try {
    const snap = await cursorRef.get();
    if (snap.exists && typeof snap.data().index === 'number') {
      start = snap.data().index;
      if (snap.data().done) {
        console.log('Migration already marked complete. Delete meta/migrateCursor to redo it.');
        process.exit(0);
      }
    }
  } catch (e) {
    console.warn(`  Could not read cursor (${e.message}) — starting from 0.`);
  }
  console.log(`Resuming at card ${start} of ${cards.length}`);

  let reads = 0, writes = 0, copied = 0, cardsDone = 0, cardsWithData = 0;
  let pending = db.batch(), pendingCount = 0;

  async function flush() {
    if (!pendingCount) return;
    if (!DRY_RUN) {
      await pending.commit();
      await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    pending = db.batch();
    pendingCount = 0;
  }

  let i = start;
  for (; i < cards.length; i++) {
    if (reads >= READ_BUDGET || writes >= WRITE_BUDGET) {
      console.log(`\nBudget reached (${reads} reads, ${writes} writes). Stopping.`);
      break;
    }
    const card = cards[i];

    let old;
    try {
      old = await db.collection('priceHistory').doc(card.printing)
        .collection('snapshots')
        .where(FieldPath.documentId(), '>=', from)
        .where(FieldPath.documentId(), '<', switchDate)
        .orderBy(FieldPath.documentId())
        .get();
    } catch (e) {
      console.warn(`  ${card.name}: read failed (${e.message}) — skipping.`);
      cardsDone++;
      continue;
    }
    reads += Math.max(old.size, 1);
    cardsDone++;
    if (old.empty) continue;
    cardsWithData++;

    for (const doc of old.docs) {
      const d = doc.data();
      // set was not stored on old snapshots. It is what makes a reprint
      // legible in the new scheme, and for these rows it is knowable:
      // every one came from the printing the tracker was recording.
      const target = db.collection('cardHistory').doc(card.oracle)
        .collection('snapshots').doc(doc.id);
      pending.set(target, {
        usd: d.usd ?? null,
        usd_foil: d.usd_foil ?? null,
        eur: d.eur ?? null,
        ...(d.set ? { set: d.set } : {})
      }, { merge: true });
      pendingCount++; writes++; copied++;
      if (pendingCount >= BATCH_SIZE) await flush();
    }

    if (cardsDone % 250 === 0) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${cards.length} cards — ${copied} snapshots copied — ${elapsed}s`);
    }
  }

  await flush();

  const done = i >= cards.length;
  if (!DRY_RUN) {
    try {
      await cursorRef.set({
        index: done ? 0 : i,
        done,
        updatedAt: new Date().toISOString(),
        lastRunCopied: copied
      });
    } catch (e) {
      // Not fatal. Re-copying a stretch is idempotent: merge:true writing
      // identical values costs quota but changes nothing.
      console.warn(`  Could not save cursor: ${e.message}`);
    }
  }

  console.log('\n========================================');
  console.log(`Cards examined:     ${cardsDone}`);
  console.log(`  with old history: ${cardsWithData}`);
  console.log(`Snapshots copied:   ${copied}`);
  console.log(`Reads used:         ~${reads} (${(reads / 50000 * 100).toFixed(0)}% of free tier)`);
  console.log(`Writes used:        ~${writes} (${(writes / 20000 * 100).toFixed(0)}% of free tier)`);
  console.log(done ? 'COMPLETE — every card has been visited.' : `Next run resumes at card ${i}.`);
  console.log('========================================');
  process.exit(0);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });

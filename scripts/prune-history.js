/**
 * MTG Price Oracle - Tiered history pruning
 *
 * Keeps the site permanently inside Firestore's free tier by thinning
 * old snapshots instead of deleting them wholesale:
 *
 *   0-90 days      every day, untouched
 *   90-365 days    one snapshot per ISO week
 *   365+ days      one snapshot per calendar month
 *
 * In every collapsed window it keeps three documents, not one: the
 * earliest (so the series has an evenly spaced anchor), the cheapest,
 * and the most expensive. Without the last two a weekly sample quietly
 * erases spikes — a card that briefly tripled mid-week would look flat
 * forever. Three docs per week still throws away 4 of 7.
 *
 * Budgets, not completeness. The collection holds far more cards than
 * the ~7,700 currently over the price floor, because the browser
 * records a snapshot for any card anyone opens. Pruning all of it in
 * one pass would blow both free quotas, so this walks the collection
 * with a cursor in meta/pruneCursor, does as much as its read and
 * delete budgets allow, and picks up where it stopped tomorrow. It is
 * meant to run daily, after track-prices.js, and to converge over a
 * couple of weeks rather than in one run.
 *
 * Both budgets default low enough to sit alongside a full tracker run
 * (~7,760 writes, ~7,730 reads) without either quota being at risk.
 */

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldPath } = admin.firestore;

// ====== CONFIG ======
const TIER1_DAYS = 90;    // younger than this: keep every day
const TIER2_DAYS = 365;   // between: keep one week's worth
                          // older: keep one month's worth
const READ_BUDGET = Number(process.env.PRUNE_READ_BUDGET || 30000);
const DELETE_BUDGET = Number(process.env.PRUNE_DELETE_BUDGET || 9000);
const CARD_PAGE = 200;    // cards listed per page
const BATCH_SIZE = 200;   // deletes per commit
const BATCH_PAUSE = 500;
const DRY_RUN = process.env.PRUNE_DRY_RUN === '1';

function isoDate(d) { return d.toISOString().split('T')[0]; }

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

/**
 * Window key for a snapshot date. Snapshots that share a key compete
 * for the same three surviving slots.
 */
function windowKey(dateStr, tier1Cutoff, tier2Cutoff) {
  if (dateStr >= tier1Cutoff) return null;          // tier 1: never pruned
  if (dateStr >= tier2Cutoff) {                     // tier 2: ISO week
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;            // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    return 'w' + isoDate(d);
  }
  return 'm' + dateStr.slice(0, 7);                 // tier 3: calendar month
}

/** Ids to keep out of one window's snapshots: earliest, cheapest, dearest. */
function keepersFor(snaps) {
  const keep = new Set([snaps[0].id]);
  const priced = snaps.filter(s => typeof s.usd === 'number');
  if (priced.length) {
    let lo = priced[0], hi = priced[0];
    for (const s of priced) {
      if (s.usd < lo.usd) lo = s;
      if (s.usd > hi.usd) hi = s;
    }
    keep.add(lo.id);
    keep.add(hi.id);
  }
  return keep;
}

async function main() {
  const started = Date.now();
  const tier1Cutoff = daysAgo(TIER1_DAYS);
  const tier2Cutoff = daysAgo(TIER2_DAYS);

  console.log('=== MTG Price Oracle - History Pruner ===');
  console.log(`Daily below ${tier1Cutoff}, weekly to ${tier2Cutoff}, monthly before that.`);
  console.log(`Budgets: ${READ_BUDGET} reads, ${DELETE_BUDGET} deletes.${DRY_RUN ? ' DRY RUN.' : ''}`);
  console.log('');

  const cursorRef = db.collection('meta').doc('pruneCursor');
  let cursor = null;
  try {
    const snap = await cursorRef.get();
    if (snap.exists) {
      // The workflow fires three times a day so that GitHub dropping or
      // delaying one cron does not lose the day. The tracker no-ops on
      // the later attempts; without this the pruner would not, and
      // three full delete budgets in a day would overrun the quota the
      // budgets exist to protect.
      if (snap.data().ranOn === isoDate(new Date()) && !process.env.PRUNE_FORCE) {
        console.log(`Already pruned today (${snap.data().ranOn}). Nothing to do.`);
        process.exit(0);
      }
      cursor = snap.data().after || null;
    }
  } catch (e) {
    console.warn(`  Could not read cursor (${e.message}) — starting from the top.`);
  }
  console.log(cursor ? `Resuming after ${cursor}` : 'Starting from the beginning of the collection');

  let reads = 0, deletes = 0, cardsSeen = 0, cardsTouched = 0;
  let pending = db.batch(), pendingCount = 0;
  let exhausted = false;

  async function flush() {
    if (!pendingCount) return;
    if (!DRY_RUN) {
      await pending.commit();
      await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    pending = db.batch();
    pendingCount = 0;
  }

  outer:
  while (!exhausted) {
    let q = db.collection('priceHistory').orderBy(FieldPath.documentId()).limit(CARD_PAGE);
    if (cursor) q = q.startAfter(cursor);

    // select() with no fields returns document refs only — still one
    // read each, but almost no bandwidth.
    const page = await q.select().get();
    reads += page.size;
    if (page.empty) {
      console.log('\nReached the end of the collection. Cursor reset.');
      cursor = null;
      break;
    }

    for (const cardDoc of page.docs) {
      cardsSeen++;
      cursor = cardDoc.id;

      // Only snapshots old enough to be prunable. Document ids are
      // dates, so this range runs server-side and never reads the
      // tier-1 window we are keeping intact anyway.
      const old = await cardDoc.ref.collection('snapshots')
        .where(FieldPath.documentId(), '<', tier1Cutoff)
        .orderBy(FieldPath.documentId())
        .get();
      reads += Math.max(old.size, 1); // an empty query still bills one read

      if (old.size > 1) {
        const windows = new Map();
        for (const s of old.docs) {
          const key = windowKey(s.id, tier1Cutoff, tier2Cutoff);
          if (!key) continue;
          const usd = s.get('usd');
          if (!windows.has(key)) windows.set(key, []);
          windows.get(key).push({ id: s.id, ref: s.ref, usd: typeof usd === 'number' ? usd : null });
        }

        let doomed = 0;
        for (const snaps of windows.values()) {
          if (snaps.length <= 3) continue;
          const keep = keepersFor(snaps);
          for (const s of snaps) {
            if (keep.has(s.id)) continue;
            pending.delete(s.ref);
            pendingCount++;
            deletes++;
            doomed++;
            if (pendingCount >= BATCH_SIZE) await flush();
          }
        }
        if (doomed) cardsTouched++;
      }

      if (deletes >= DELETE_BUDGET || reads >= READ_BUDGET) {
        exhausted = true;
        console.log(`\nBudget reached (${reads} reads, ${deletes} deletes). Stopping here.`);
        break outer;
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  ${cardsSeen} cards scanned, ${deletes} snapshots dropped — ${elapsed}s`);
  }

  await flush();

  if (!DRY_RUN) {
    try {
      await cursorRef.set({
        after: cursor,
        ranOn: isoDate(new Date()),
        updatedAt: new Date().toISOString(),
        lastRunDeletes: deletes,
        lastRunReads: reads
      });
    } catch (e) {
      // Not fatal — the next run redoes this stretch, which is a no-op
      // for anything already pruned.
      console.warn(`  Could not save cursor: ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n========================================');
  console.log(`Cards scanned:     ${cardsSeen}`);
  console.log(`Cards thinned:     ${cardsTouched}`);
  console.log(`Snapshots dropped: ${deletes}`);
  console.log(`Reads used:        ~${reads} (${(reads / 50000 * 100).toFixed(0)}% of free tier)`);
  console.log(`Deletes used:      ~${deletes} (${(deletes / 20000 * 100).toFixed(0)}% of the write tier)`);
  console.log(`Cursor now:        ${cursor || '(start of collection)'}`);
  console.log(`Time:              ${elapsed}s`);
  console.log('========================================');

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

/**
 * Daily Price Tracker for MTG Price Oracle
 * Fetches prices for popular cards and stores in Firebase
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Scryfall API helper with rate limiting
const SCRYFALL_DELAY = 100; // ms between requests
let lastRequest = 0;

async function scryfallFetch(url) {
  const now = Date.now();
  const wait = SCRYFALL_DELAY - (now - lastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Scryfall error: ${response.status}`);
  return response.json();
}

async function searchCards(query, limit = 50) {
  const cards = [];
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=usd&dir=desc`;

  while (url && cards.length < limit) {
    const data = await scryfallFetch(url);
    cards.push(...data.data);
    url = data.has_more && cards.length < limit ? data.next_page : null;
  }

  return cards.slice(0, limit);
}

async function recordPrice(card) {
  const today = new Date().toISOString().split('T')[0];
  const prices = {
    usd: parseFloat(card.prices?.usd) || null,
    usd_foil: parseFloat(card.prices?.usd_foil) || null,
    eur: parseFloat(card.prices?.eur) || null,
    name: card.name,
    set: card.set
  };

  if (!prices.usd && !prices.usd_foil) return false;

  try {
    // Record daily snapshot
    await db.collection('priceHistory').doc(card.id)
      .collection('snapshots').doc(today).set(prices);

    // Update metadata
    await db.collection('priceHistory').doc(card.id).set({
      name: card.name,
      set: card.set,
      setName: card.set_name,
      lastUpdated: today
    }, { merge: true });

    return true;
  } catch (e) {
    console.error(`Failed to record ${card.name}:`, e.message);
    return false;
  }
}

async function main() {
  console.log('=== MTG Price Oracle - Daily Price Tracker ===');
  console.log(`Date: ${new Date().toISOString()}`);

  const queries = [
    // Commander Staples (most popular format)
    { name: 'Commander Staples', query: 'f:commander is:staple usd>1', limit: 100 },

    // Modern Staples
    { name: 'Modern Staples', query: 'f:modern is:staple usd>5', limit: 75 },

    // Pioneer Staples
    { name: 'Pioneer Staples', query: 'f:pioneer is:staple usd>2', limit: 50 },

    // Legacy/Vintage High Value
    { name: 'Legacy Staples', query: 'f:legacy is:staple usd>10', limit: 50 },

    // Reserved List
    { name: 'Reserved List', query: 'is:reserved usd>5', limit: 75 },

    // Standard (rotates, so track current)
    { name: 'Standard Cards', query: 'f:standard usd>1', limit: 50 },

    // High Value Cards Overall
    { name: 'High Value Cards', query: 'usd>50', limit: 100 },

    // Recent Sets Mythics
    { name: 'Recent Mythics', query: 'r:mythic year>=2024 usd>2', limit: 75 },

    // Popular Commanders
    { name: 'Legendary Creatures', query: 't:legendary t:creature f:commander usd>3', limit: 75 },

    // Mana Rocks & Ramp
    { name: 'Mana Rocks', query: '(t:artifact o:"add" o:"mana") usd>1', limit: 50 }
  ];

  let totalRecorded = 0;
  const trackedIds = new Set(); // Avoid duplicates

  for (const { name, query, limit } of queries) {
    console.log(`\nFetching: ${name}...`);
    try {
      const cards = await searchCards(query, limit);
      let recorded = 0;

      for (const card of cards) {
        if (trackedIds.has(card.id)) continue;
        trackedIds.add(card.id);

        if (await recordPrice(card)) {
          recorded++;
          totalRecorded++;
        }
      }

      console.log(`  Recorded ${recorded} prices for ${name}`);
    } catch (e) {
      console.error(`  Error fetching ${name}:`, e.message);
    }
  }

  console.log(`\n=== Complete ===`);
  console.log(`Total unique cards tracked: ${totalRecorded}`);

  // Cleanup: Delete snapshots older than 90 days (to manage storage)
  console.log('\nCleaning up old snapshots...');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Note: Full cleanup would require iterating all docs - skipping for now
  // to avoid excessive reads. Can implement later if storage becomes an issue.

  console.log('Done!');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

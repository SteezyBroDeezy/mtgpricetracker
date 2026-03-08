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
    // ====== CORE STAPLES ======
    { name: 'Commander Staples', query: 'f:commander is:staple usd>1', limit: 100 },
    { name: 'Modern Staples', query: 'f:modern is:staple usd>5', limit: 75 },
    { name: 'Pioneer Staples', query: 'f:pioneer is:staple usd>2', limit: 50 },
    { name: 'Legacy Staples', query: 'f:legacy is:staple usd>10', limit: 50 },
    { name: 'Reserved List', query: 'is:reserved usd>5', limit: 75 },
    { name: 'Standard Cards', query: 'f:standard usd>1', limit: 50 },
    { name: 'High Value Cards', query: 'usd>50', limit: 100 },
    { name: 'Recent Mythics', query: 'r:mythic year>=2024 usd>2', limit: 75 },
    { name: 'Legendary Creatures', query: 't:legendary t:creature f:commander usd>3', limit: 75 },
    { name: 'Mana Rocks', query: '(t:artifact o:"add" o:"mana") usd>1', limit: 50 },

    // ====== PRICE TIERS (Budget Focus) ======
    { name: 'Budget Under $2', query: 'usd<2 usd>0.10', limit: 50 },
    { name: 'Budget $2-$5', query: 'usd<5 usd>=2', limit: 50 },
    { name: 'Budget $5-$10', query: 'usd<10 usd>=5', limit: 50 },
    { name: 'Budget $10-$20', query: 'usd<20 usd>=10', limit: 50 },

    // ====== BY COLOR (Budget) ======
    { name: 'White Budget', query: 'c:w usd<20 usd>0.50', limit: 40 },
    { name: 'Blue Budget', query: 'c:u usd<20 usd>0.50', limit: 40 },
    { name: 'Black Budget', query: 'c:b usd<20 usd>0.50', limit: 40 },
    { name: 'Red Budget', query: 'c:r usd<20 usd>0.50', limit: 40 },
    { name: 'Green Budget', query: 'c:g usd<20 usd>0.50', limit: 40 },
    { name: 'Colorless Budget', query: 'c:c usd<20 usd>0.50', limit: 40 },
    { name: 'Multicolor Budget', query: 'c>=2 usd<20 usd>0.50', limit: 40 },

    // ====== CREATURE TYPES ======
    { name: 'Dragons', query: 't:dragon usd<20 usd>0.50', limit: 30 },
    { name: 'Elves', query: 't:elf usd<20 usd>0.50', limit: 30 },
    { name: 'Goblins', query: 't:goblin usd<20 usd>0.50', limit: 30 },
    { name: 'Zombies', query: 't:zombie usd<20 usd>0.50', limit: 30 },
    { name: 'Angels', query: 't:angel usd<20 usd>0.50', limit: 30 },
    { name: 'Vampires', query: 't:vampire usd<20 usd>0.50', limit: 30 },
    { name: 'Wizards', query: 't:wizard usd<20 usd>0.50', limit: 30 },
    { name: 'Demons', query: 't:demon usd<20 usd>0.50', limit: 30 },

    // ====== CARD TYPES ======
    { name: 'Instants Budget', query: 't:instant usd<20 usd>0.50', limit: 40 },
    { name: 'Sorceries Budget', query: 't:sorcery usd<20 usd>0.50', limit: 40 },
    { name: 'Enchantments Budget', query: 't:enchantment usd<20 usd>0.50', limit: 40 },
    { name: 'Artifacts Budget', query: 't:artifact usd<20 usd>0.50', limit: 40 },
    { name: 'Lands Budget', query: 't:land usd<20 usd>0.50', limit: 40 },
    { name: 'Planeswalkers Budget', query: 't:planeswalker usd<20 usd>0.50', limit: 30 },

    // ====== TMNT / SECRET LAIR ======
    { name: 'TMNT Top', query: 'set:sld (ninja or turtle or tmnt) usd>0', limit: 50 },
    { name: 'TMNT Creatures', query: 'set:sld (ninja or turtle) t:creature usd>0', limit: 30 },
    { name: 'TMNT Legendary', query: 'set:sld (ninja or turtle) t:legendary usd>0', limit: 30 },

    // ====== LORWYN (Original + Remastered) ======
    // Lorwyn Eclipsed (set:ecl) - Regular Boosters
    { name: 'Lorwyn Eclipsed Top', query: 'set:ecl is:booster usd>0', limit: 50 },
    { name: 'Lorwyn Eclipsed Mythics', query: 'set:ecl is:booster r:mythic usd>0', limit: 30 },
    { name: 'Lorwyn Elves', query: 'set:ecl t:elf usd>0', limit: 30 },
    { name: 'Lorwyn Faeries', query: 'set:ecl t:faerie usd>0', limit: 30 },
    { name: 'Lorwyn Goblins', query: 'set:ecl t:goblin usd>0', limit: 30 },
    { name: 'Lorwyn Merfolk', query: 'set:ecl t:merfolk usd>0', limit: 30 },
    { name: 'Lorwyn Treefolk', query: 'set:ecl t:treefolk usd>0', limit: 30 },
    // Lorwyn Eclipsed Collector Boosters
    { name: 'Lorwyn Collector', query: 'set:ecl (is:extendedart or is:showcase or is:borderless) usd>0', limit: 50 },

    // ====== COMMANDER SETS 2024-2025 ======
    { name: 'CMD Sets Top', query: 'set:cmm or set:c24 or set:otp usd>0', limit: 50 },
    { name: 'CMD Commanders', query: '(set:cmm or set:c24 or set:otp) t:legendary t:creature usd>0', limit: 50 },
    { name: 'CMD Mythics', query: '(set:cmm or set:c24 or set:otp) r:mythic usd>0', limit: 40 },
    { name: 'CMD Artifacts', query: '(set:cmm or set:c24 or set:otp) t:artifact usd>0', limit: 40 },
    { name: 'CMD Enchantments', query: '(set:cmm or set:c24 or set:otp) t:enchantment usd>0', limit: 40 },
    { name: 'CMD Lands', query: '(set:cmm or set:c24 or set:otp) t:land usd>0', limit: 40 },

    // ====== RARITY BUDGET ======
    { name: 'Mythics Under $20', query: 'r:mythic usd<20 usd>1', limit: 50 },
    { name: 'Rares Under $10', query: 'r:rare usd<10 usd>0.50', limit: 50 },
    { name: 'Uncommons Under $5', query: 'r:uncommon usd<5 usd>0.25', limit: 40 },
    { name: 'Commons Under $2', query: 'r:common usd<2 usd>0.10', limit: 40 },

    // ====== PAUPER ======
    { name: 'Pauper Staples', query: 'f:pauper usd>0.10', limit: 50 },

    // ====== FINAL FANTASY ======
    { name: 'Final Fantasy Top', query: 'set:fdn usd>0', limit: 50 },
    { name: 'FF Mythics', query: 'set:fdn r:mythic usd>0', limit: 30 },
    { name: 'FF Rares', query: 'set:fdn r:rare usd>0', limit: 40 },
    { name: 'FF Creatures', query: 'set:fdn t:creature usd>0', limit: 40 },
    { name: 'FF Legendary', query: 'set:fdn t:legendary usd>0', limit: 30 },

    // ====== AETHERDRIFT ======
    { name: 'Aetherdrift Top', query: 'set:dft usd>0', limit: 50 },
    { name: 'Drift Mythics', query: 'set:dft r:mythic usd>0', limit: 30 },
    { name: 'Drift Vehicles', query: 'set:dft t:vehicle usd>0', limit: 30 },
    { name: 'Drift Creatures', query: 'set:dft t:creature usd>0', limit: 40 },
    { name: 'Drift Legendary', query: 'set:dft t:legendary usd>0', limit: 30 },

    // ====== SPIDER-MAN ======
    { name: 'Spider-Man Top', query: '(set:spg or (spider-man)) usd>0', limit: 50 },
    { name: 'Spidey Mythics', query: '(set:spg or (spider-man)) r:mythic usd>0', limit: 30 },
    { name: 'Spidey Creatures', query: '(set:spg or (spider-man)) t:creature usd>0', limit: 40 },
    { name: 'Spidey Legendary', query: '(set:spg or (spider-man)) t:legendary usd>0', limit: 30 },

    // ====== AVATAR: THE LAST AIRBENDER ======
    { name: 'ATLA Top', query: 'set:tla usd>0', limit: 50 },
    { name: 'ATLA Mythics', query: 'set:tla r:mythic usd>0', limit: 30 },
    { name: 'ATLA Creatures', query: 'set:tla t:creature usd>0', limit: 40 },
    { name: 'ATLA Legendary', query: 'set:tla t:legendary usd>0', limit: 30 },

    // ====== DRAGONS OF TARKIR ======
    { name: 'Dragons of Tarkir Top', query: 'set:dtk usd>0', limit: 50 },
    { name: 'Tarkir Dragons', query: 'set:dtk t:dragon usd>0', limit: 30 },
    { name: 'Dragonlords', query: 'set:dtk dragonlord usd>0', limit: 10 },
    { name: 'Tarkir Mythics', query: 'set:dtk r:mythic usd>0', limit: 30 },
    { name: 'Tarkir Rares', query: 'set:dtk r:rare usd>0', limit: 40 },

    // ====== FOUNDATIONS ======
    { name: 'Foundations Top', query: 'set:fdn usd>0', limit: 50 },
    { name: 'Foundations Mythics', query: 'set:fdn r:mythic usd>0', limit: 30 },
    { name: 'Foundations Rares', query: 'set:fdn r:rare usd>0', limit: 40 },

    // ====== DUSKMOURN ======
    { name: 'Duskmourn Top', query: 'set:dsk usd>0', limit: 50 },
    { name: 'Duskmourn Mythics', query: 'set:dsk r:mythic usd>0', limit: 30 },
    { name: 'Duskmourn Horrors', query: 'set:dsk t:horror usd>0', limit: 30 },

    // ====== BLOOMBURROW ======
    { name: 'Bloomburrow Top', query: 'set:blb usd>0', limit: 50 },
    { name: 'Bloomburrow Mythics', query: 'set:blb r:mythic usd>0', limit: 30 },
    { name: 'Bloomburrow Mice', query: 'set:blb t:mouse usd>0', limit: 20 },

    // ====== ASSASSINS CREED ======
    { name: 'Assassins Creed Top', query: 'set:acr usd>0', limit: 50 },
    { name: 'ACR Mythics', query: 'set:acr r:mythic usd>0', limit: 30 },
    { name: 'ACR Legendary', query: 'set:acr t:legendary usd>0', limit: 30 },

    // ====== MODERN HORIZONS 3 ======
    { name: 'MH3 Top', query: 'set:mh3 usd>0', limit: 50 },
    { name: 'MH3 Mythics', query: 'set:mh3 r:mythic usd>0', limit: 30 },
    { name: 'MH3 Lands', query: 'set:mh3 t:land usd>0', limit: 30 },

    // ====== OUTLAWS OF THUNDER JUNCTION ======
    { name: 'OTJ Top', query: 'set:otj usd>0', limit: 50 },
    { name: 'OTJ Mythics', query: 'set:otj r:mythic usd>0', limit: 30 },
    { name: 'OTJ Legendary', query: 'set:otj t:legendary usd>0', limit: 30 },

    // ====== FALLOUT ======
    { name: 'Fallout Top', query: 'set:pip usd>0', limit: 50 },
    { name: 'Fallout Mythics', query: 'set:pip r:mythic usd>0', limit: 30 },
    { name: 'Fallout Legendary', query: 'set:pip t:legendary usd>0', limit: 30 },

    // ====== MURDERS AT KARLOV MANOR ======
    { name: 'MKM Top', query: 'set:mkm usd>0', limit: 50 },
    { name: 'MKM Mythics', query: 'set:mkm r:mythic usd>0', limit: 30 },
    { name: 'MKM Detectives', query: 'set:mkm t:detective usd>0', limit: 20 },

    // ====== RAVNICA REMASTERED ======
    { name: 'RVR Top', query: 'set:rvr usd>0', limit: 50 },
    { name: 'RVR Mythics', query: 'set:rvr r:mythic usd>0', limit: 30 },
    { name: 'RVR Shocklands', query: 'set:rvr t:land o:"pay 2 life" usd>0', limit: 20 },

    // ====== LOST CAVERNS OF IXALAN ======
    { name: 'LCI Top', query: 'set:lci usd>0', limit: 50 },
    { name: 'LCI Mythics', query: 'set:lci r:mythic usd>0', limit: 30 },
    { name: 'LCI Dinosaurs', query: 'set:lci t:dinosaur usd>0', limit: 30 },

    // ====== DOCTOR WHO ======
    { name: 'Doctor Who Top', query: 'set:who usd>0', limit: 50 },
    { name: 'WHO Mythics', query: 'set:who r:mythic usd>0', limit: 30 },
    { name: 'WHO Legendary', query: 'set:who t:legendary usd>0', limit: 30 },

    // ====== WILDS OF ELDRAINE ======
    { name: 'WOE Top', query: 'set:woe usd>0', limit: 50 },
    { name: 'WOE Mythics', query: 'set:woe r:mythic usd>0', limit: 30 },
    { name: 'WOE Faeries', query: 'set:woe t:faerie usd>0', limit: 30 },

    // ====== COMMANDER MASTERS ======
    { name: 'CMM Top', query: 'set:cmm usd>0', limit: 50 },
    { name: 'CMM Mythics', query: 'set:cmm r:mythic usd>0', limit: 30 },
    { name: 'CMM Commanders', query: 'set:cmm t:legendary t:creature usd>0', limit: 40 },

    // ====== LORD OF THE RINGS ======
    { name: 'LTR Top', query: 'set:ltr usd>0', limit: 50 },
    { name: 'LTR Mythics', query: 'set:ltr r:mythic usd>0', limit: 30 },
    { name: 'LTR Legendary', query: 'set:ltr t:legendary usd>0', limit: 40 },

    // ====== MARCH OF THE MACHINE ======
    { name: 'MOM Top', query: 'set:mom usd>0', limit: 50 },
    { name: 'MOM Mythics', query: 'set:mom r:mythic usd>0', limit: 30 },
    { name: 'MOM Battles', query: 'set:mom t:battle usd>0', limit: 20 },

    // ====== PHYREXIA ALL WILL BE ONE ======
    { name: 'ONE Top', query: 'set:one usd>0', limit: 50 },
    { name: 'ONE Mythics', query: 'set:one r:mythic usd>0', limit: 30 },
    { name: 'ONE Phyrexians', query: 'set:one t:phyrexian usd>0', limit: 30 },

    // ====== DOMINARIA REMASTERED ======
    { name: 'DMR Top', query: 'set:dmr usd>0', limit: 50 },
    { name: 'DMR Mythics', query: 'set:dmr r:mythic usd>0', limit: 30 },
    { name: 'DMR Legendary', query: 'set:dmr t:legendary usd>0', limit: 30 },

    // ====== BULK SET TRACKING (All cards, sorted by price) ======
    // 2025 Sets
    { name: '2025 All Cards', query: 'year:2025 usd>0', limit: 100 },

    // 2024 Sets - Full Coverage
    { name: 'Murders at Karlov Manor Full', query: 'set:mkm usd>0.25', limit: 75 },
    { name: 'Ravnica Remastered Full', query: 'set:rvr usd>0.25', limit: 75 },
    { name: 'Karlov Manor Commander', query: 'set:mkc usd>0.25', limit: 50 },
    { name: 'Outlaws Thunder Junction Full', query: 'set:otj usd>0.25', limit: 75 },
    { name: 'OTJ Commander', query: 'set:otc usd>0.25', limit: 50 },
    { name: 'Big Score', query: 'set:big usd>0.25', limit: 30 },
    { name: 'Breaking News', query: 'set:otp usd>0.25', limit: 40 },
    { name: 'Modern Horizons 3 Full', query: 'set:mh3 usd>0.25', limit: 100 },
    { name: 'MH3 Commander', query: 'set:m3c usd>0.25', limit: 50 },
    { name: 'Assassins Creed Full', query: 'set:acr usd>0.25', limit: 75 },
    { name: 'Bloomburrow Full', query: 'set:blb usd>0.25', limit: 75 },
    { name: 'Bloomburrow Commander', query: 'set:blc usd>0.25', limit: 50 },
    { name: 'Duskmourn Full', query: 'set:dsk usd>0.25', limit: 75 },
    { name: 'Duskmourn Commander', query: 'set:dsc usd>0.25', limit: 50 },
    { name: 'Foundations Full', query: 'set:fdn usd>0.25', limit: 75 },
    { name: 'Foundations Jumpstart', query: 'set:j25 usd>0.25', limit: 50 },

    // 2023 Sets - Full Coverage
    { name: 'Phyrexia ONE Full', query: 'set:one usd>0.25', limit: 75 },
    { name: 'ONE Commander', query: 'set:onc usd>0.25', limit: 50 },
    { name: 'March Machine Full', query: 'set:mom usd>0.25', limit: 75 },
    { name: 'MOM Commander', query: 'set:moc usd>0.25', limit: 50 },
    { name: 'MOM Aftermath', query: 'set:mat usd>0.25', limit: 30 },
    { name: 'LOTR Full', query: 'set:ltr usd>0.25', limit: 100 },
    { name: 'LOTR Commander', query: 'set:ltc usd>0.25', limit: 50 },
    { name: 'Commander Masters Full', query: 'set:cmm usd>0.25', limit: 100 },
    { name: 'Wilds Eldraine Full', query: 'set:woe usd>0.25', limit: 75 },
    { name: 'WOE Commander', query: 'set:woc usd>0.25', limit: 50 },
    { name: 'Lost Caverns Full', query: 'set:lci usd>0.25', limit: 75 },
    { name: 'LCI Commander', query: 'set:lcc usd>0.25', limit: 50 },
    { name: 'Doctor Who Full', query: 'set:who usd>0.25', limit: 75 },

    // 2022 Sets - Key Sets
    { name: 'Brothers War Full', query: 'set:bro usd>0.25', limit: 75 },
    { name: 'BRO Commander', query: 'set:brc usd>0.25', limit: 50 },
    { name: 'Dominaria United Full', query: 'set:dmu usd>0.25', limit: 75 },
    { name: 'DMU Commander', query: 'set:dmc usd>0.25', limit: 50 },
    { name: 'Streets New Capenna Full', query: 'set:snc usd>0.25', limit: 75 },
    { name: 'SNC Commander', query: 'set:ncc usd>0.25', limit: 50 },
    { name: 'Kamigawa Neon Full', query: 'set:neo usd>0.25', limit: 75 },
    { name: 'NEO Commander', query: 'set:nec usd>0.25', limit: 50 },
    { name: 'Double Masters 2022', query: 'set:2x2 usd>0.25', limit: 100 },
    { name: 'Baldurs Gate Full', query: 'set:clb usd>0.25', limit: 100 },
    { name: 'Unfinity', query: 'set:unf usd>0.25', limit: 50 },

    // 2021 Key Sets
    { name: 'MH2 Full', query: 'set:mh2 usd>0.25', limit: 100 },
    { name: 'Innistrad Midnight Hunt', query: 'set:mid usd>0.25', limit: 75 },
    { name: 'Innistrad Crimson Vow', query: 'set:vow usd>0.25', limit: 75 },
    { name: 'AFR Forgotten Realms', query: 'set:afr usd>0.25', limit: 75 },
    { name: 'Strixhaven Full', query: 'set:stx usd>0.25', limit: 75 },
    { name: 'Kaldheim Full', query: 'set:khm usd>0.25', limit: 75 },
    { name: 'Time Spiral Remastered', query: 'set:tsr usd>0.25', limit: 75 },

    // Evergreen High-Value
    { name: 'All Fetchlands', query: '(t:land o:"search your library" o:"pay 1 life") usd>5', limit: 50 },
    { name: 'All Shocklands', query: 't:land o:"pay 2 life" usd>3', limit: 30 },
    { name: 'All Triomes', query: 't:land o:"cycling" (type:plains or type:island or type:swamp or type:mountain or type:forest) usd>2', limit: 20 },

    // ====== COLLECTOR BOOSTER / SPECIAL PRINTINGS ======
    { name: 'Borderless 2024-2025', query: 'is:borderless year>=2024 usd>5', limit: 50 },
    { name: 'Showcase 2024-2025', query: 'is:showcase year>=2024 usd>3', limit: 50 },
    { name: 'Extended Art 2024-2025', query: 'is:extendedart year>=2024 usd>3', limit: 50 },
    { name: 'MH3 Collector', query: 'set:mh3 (is:extendedart or is:showcase or is:borderless) usd>0', limit: 50 },
    { name: 'LOTR Collector', query: 'set:ltr (is:extendedart or is:showcase or is:borderless) usd>0', limit: 50 },
    { name: 'Serialized Cards', query: 'is:serialized usd>0', limit: 30 }
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

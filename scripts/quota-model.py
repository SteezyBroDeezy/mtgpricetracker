"""Firestore storage math for the MTG Price Oracle, using Google's documented
size formula: https://firebase.google.com/docs/firestore/storage-size

  string field value = utf8 bytes + 1
  double / integer    = 8
  document name size  = sum(len(segment)+1 for each collection id and doc id) + 16
  document size       = name size + sum(field name size + field value size) + 32
  index entry size    = document name size + indexed field value size + 32
  single-field indexing creates an ASC and a DESC entry per field
"""

GiB = 1024 ** 3
FREE_STORAGE = 1 * GiB
FREE_WRITES = 20_000
FREE_READS = 50_000

CARDS_UNIQUE = 7_729    # scryfall q=usd>=0.50 (unique=cards)
CARDS_PRINTS = 41_140   # same query, unique=prints


def s(text_len):
    return text_len + 1


# priceHistory/{36-char uuid}/snapshots/{YYYY-MM-DD}
NAME = s(len("priceHistory")) + s(36) + s(len("snapshots")) + s(10) + 16

SCHEMAS = {
    "current (usd, usd_foil, eur, name, set)": [
        ("usd", 8), ("usd_foil", 8), ("eur", 8), ("name", 17), ("set", 4)
    ],
    "trimmed (usd, usd_foil, eur)": [
        ("usd", 8), ("usd_foil", 8), ("eur", 8)
    ],
}


def doc_size(fields):
    return NAME + sum(s(len(n)) + v for n, v in fields) + 32


def index_size(fields, exempt):
    if exempt:
        # only the built-in __name__ index remains
        return 2 * (NAME + 32)
    return sum(2 * (NAME + v + 32) for _, v in fields) + 2 * (NAME + 32)


print(f"document name size: {NAME} B\n")
print(f"{'schema':42} {'indexed':>9} {'doc':>6} {'idx':>7} {'total':>7}")
print("-" * 76)
variants = {}
for label, fields in SCHEMAS.items():
    for exempt in (False, True):
        d, i = doc_size(fields), index_size(fields, exempt)
        tag = "exempt" if exempt else "default"
        variants[(label, exempt)] = d + i
        print(f"{label:42} {tag:>9} {d:>6} {i:>7} {d+i:>7}")

print()
print("=" * 76)
print("DAILY COST AND HOW LONG 1 GiB LASTS (no pruning)")
print("=" * 76)
print(f"{'schema / indexing':52} {'MB/day':>8} {'days':>7} {'years':>6}")
print("-" * 76)
for (label, exempt), per in variants.items():
    tag = "exempt" if exempt else "default"
    per_day = CARDS_UNIQUE * per
    days = FREE_STORAGE / per_day
    print(f"{label + '  [' + tag + ']':52} {per_day/1e6:>8.2f} {days:>7.0f} {days/365:>6.2f}")

print()
print("all 41,140 printings, trimmed+exempt:", end=" ")
per = variants[("trimmed (usd, usd_foil, eur)", True)]
print(f"{CARDS_PRINTS*per/1e6:.1f} MB/day -> {FREE_STORAGE/(CARDS_PRINTS*per):.0f} days"
      f"  ({CARDS_PRINTS} writes/day = {CARDS_PRINTS/FREE_WRITES*100:.0f}% of the write quota -- over budget)")

print()
print("=" * 76)
print("TIERED RETENTION: daily 90d / weekly to 1y / monthly forever")
print("=" * 76)
# One document survives each collapsed window, carrying usd_lo and usd_hi
# for the window. Keeping the cheapest and dearest days as their own
# documents instead costs three times as much and puts five years over
# the free tier -- that mistake was made once already; see the header.
DAILY = variants[("trimmed (usd, usd_foil, eur)", True)]
COLLAPSED = DAILY + 2 * (s(len("usd_lo")) + 8)
TIER1, TIER2 = 90, 365
weeks = (TIER2 - TIER1) / 7

print(f"tier-1 doc {DAILY} B, collapsed doc {COLLAPSED} B (+usd_lo/usd_hi)")
print(f"{'age':>6} {'docs/card':>10} {'total docs':>12} {'storage':>10} {'% of 1 GiB':>11}")
print("-" * 76)
for years in (1, 2, 3, 5, 10, 20):
    months = max(0, (years * 365 - TIER2) / 30.44)
    docs = TIER1 + weeks + months
    size = (TIER1 * DAILY + (weeks + months) * COLLAPSED) * CARDS_UNIQUE
    print(f"{years:>5}y {docs:>10.0f} {docs*CARDS_UNIQUE:>12,.0f} {size/1e6:>8.0f} MB {size/FREE_STORAGE*100:>10.1f}%")

print()
print("unpruned at 5y:",
      f"{5*365*CARDS_UNIQUE*DAILY/1e6:.0f} MB "
      f"({5*365*CARDS_UNIQUE*DAILY/FREE_STORAGE*100:.0f}% of 1 GiB)")
print(f"growth after year 1: {12*COLLAPSED*CARDS_UNIQUE/1e6:.1f} MB/year")

print()
print("=" * 76)
print("DAILY WRITE BUDGET (20,000/day free)")
print("=" * 76)
prune = CARDS_UNIQUE * 6 / 7   # 6 of every 7 days die when crossing the 90d line
rows = [
    ("snapshot writes", CARDS_UNIQUE),
    ("meta writes (new cards only)", 30),
    ("run marker", 1),
    ("tier-1 -> tier-2 prune deletes", prune),
    ("anchor rewrites (1/card/week)", CARDS_UNIQUE / 7),
]
tot = 0
for label, n in rows:
    tot += n
    print(f"  {label:38} {n:>8,.0f}")
print(f"  {'TOTAL':38} {tot:>8,.0f}  ({tot/FREE_WRITES*100:.0f}% of free tier)")
print(f"  headroom before hitting the cap:        {FREE_WRITES-tot:>8,.0f}")

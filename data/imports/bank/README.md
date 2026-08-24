# In-game inventory/bank exports

Drop each mule/alt's raw inventory export here (this directory is gitignored
except this README — see `.gitignore`, same convention as
`data/imports/sos-bot/`). See PLAN.md §3, §4f, §9, and §11 Phase 8 for the
full context.

## Naming

One file per character, named by the character it belongs to. **Format
confirmed 2026-08-24**: this is a Zeal inventory export —
`<CharName>-Inventory.txt` or `<CharName>-Inventory_pq.proj.txt`,
tab-delimited `Location\tName\tID\tCount/Charges\tSlots`. The sibling
`pq-companion` repo's `backend/internal/zeal` package (`reader.go`,
`scanner.go`) already parses this exact format — task 8.3 ports that,
rather than writing a new parser from scratch (§3 addendum).

Two files here so far are **format references only, not real mule data**:
one player's own bazaar-trader export, plus a second character on the same
account to demonstrate account-shared data (see the SharedBank section
below). Neither should ever be imported as guild bank content. Still need
**real mule exports** before task 8.4's actual import can be finished.

## `SharedBank*` and `Bank-Coin` are account-wide, not per-character

Confirmed against the two reference exports above: their `SharedBank1`-
`SharedBank30` rows and `Bank-Coin` value were byte-identical (same
account, two characters), while `General-Coin` and personal `Bank1`-
`Bank30` differed. Import every mule's full export naively and every
shared item plus the banked currency gets counted once per mule sharing
that account.

Also: PQ only ever populates `SharedBank` slots 1-10, even though the
export always carries all 30 modern-client slots — `pq-companion`'s
`scanner.go` (`maxSharedBankSlot = 10`) already found this the hard way.
11-30 are dead rows, drop them at parse time.

**Resolved without any new schema/account concept.** The officer app's
per-file picker (task 8.3) gets a **"this mule reports SharedBank/
Bank-Coin"** toggle — on for exactly one mule per real account, off for
every other mule sharing it. The app strips those rows from every other
mule's payload before it's ever sent, so `bank_holdings` stays exactly as
simple and mule-independent as §4f already designed (still no `accounts`
table). You'll need to tell the app (or eventually the site) which mules
share a real account — there's no way to infer that from an export file
alone.

## Mule vs. hybrid alt — working assumption, confirm before 8.3 is built

Not every holder character is necessarily a pure mule — an alt might carry
guild bank items in some bags/tabs and the player's own gear in others.
`bank_holdings.status` (§4f: `guild_bank | reserved | ...`) exists
specifically for this, but *how* an officer marks the split hasn't been
decided. Two options, in rough order of how much this codebase already
leans toward each:

1. **Container-level, at import time (recommended).** The officer app
   (task 8.3) lets the officer pick, per character, either "full mule —
   import everything" or a specific set of containers/tabs (e.g. "only
   Bank1-Bank4") to import as guild bank — matching the app's existing
   "select which log files are mule accounts" request. Personal items in
   excluded containers are never even sent to the server. Survives
   re-import cleanly since the rule lives with the character/import
   config, not with the volatile row data that gets deleted and
   reinserted every time (§3's "delete-and-replace per character").
2. **Row-level, after import, on the website.** Import everything, then an
   officer manually flags specific rows `reserved` via task 8.6's
   website edit UI. Simpler parser, but a delete-and-replace re-import
   would need to remember and reapply those manual flags somehow, or
   they'd be wiped on every re-import — more moving parts for an alt that
   gets re-exported often.

Went with option 1 as the working assumption for 8.3's design; flag if
that's wrong before real parsing code gets written against it.

## Import path (once 8.3 exists)

Will mirror `scripts/import-sos-bot-dump.ts`'s pattern: staged, reviewable,
idempotent. Not written yet.

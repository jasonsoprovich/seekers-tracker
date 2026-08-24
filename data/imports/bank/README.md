# In-game inventory/bank exports

Drop each mule/alt's raw inventory export here (this directory is gitignored
except this README — see `.gitignore`, same convention as
`data/imports/sos-bot/`). See PLAN.md §3, §4f, §9, and §11 Phase 8 for the
full context.

## Naming

One file per character, named by the character it belongs to (whatever
extension your export tool produces, e.g. `Muleflorp.txt`) — don't worry
about getting the "right" shape. Task 8.3 (the parser, in
`seekers-epgp-parser`) hasn't been written yet and can't be until a real
export has been seen — every prior parser in this project (the sheet
import, Toryn's dump) was written against real data, never a guessed
format.

## Mule vs. hybrid alt — open question, needs a call before 8.3 is built

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

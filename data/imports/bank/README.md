# In-game inventory/bank exports

Drop each mule/alt's raw inventory export here (this directory is gitignored
except this README — see `.gitignore`, same convention as
`data/imports/sos-bot/`). See PLAN.md §3, §4f, §9, and §11 Phase 8 for the
full context.

**Phase 8.4 (the real sync) is built**, on `feature/guild-bank-sync` in both
`seekers-tracker` and `seekers-epgp-parser`, not yet merged/deployed. This
file no longer describes a plan — it describes what was actually built,
below.

## Naming

One file per character, named by the character it belongs to: a Zeal
inventory export — `<CharName>-Inventory.txt` or
`<CharName>-Inventory_pq.proj.txt`, tab-delimited `Location\tName\tID\t
Count/Charges\tSlots`. `seekers-epgp-parser/internal/bankexport.Discover`
scans the officer's configured EverQuest folder directly (not a `Logs`
subfolder — Zeal's `/outputfile` writes to the EQ root) for these files and
keeps the newer of two filename variants per character.

Two files here so far are **format references only, not real mule data**:
one player's own bazaar-trader export, plus a second character on the same
account to demonstrate account-shared data. Neither has ever been synced as
guild bank content.

## `SharedBank*` and `Bank-Coin` are account-wide, not per-character

Confirmed against the two reference exports above: their `SharedBank1`-
`SharedBank30` rows and `Bank-Coin` value were byte-identical (same
account, two characters), while `General-Coin` and personal `Bank1`-
`Bank30` differed.

Also: PQ only ever populates `SharedBank` slots 1-10, even though the
export always carries all 30 modern-client slots
(`bankexport.maxSharedBankSlot`) — 11-30 are dropped at parse time.
Currency (`General-Coin`/`Bank-Coin`) is never tracked at all, per the
guild's own call — dropped at the `bankexport.BuildInventory` layer, never
shown in the app, never synced.

**How it's actually solved**: a `bank_eq_accounts` table groups the
characters that share one real EQ login, with one designated **SharedBank
holder** character per group (`bank_eq_accounts.shared_bank_holder_
character_id`). The officer app's Guild Bank tab suggests a grouping
automatically by comparing two exports' `SharedBankFingerprint` (a hash of
sorted SharedBank contents — empty SharedBanks never match), and the
officer confirms or edits it. Only the group's holder can ever have a
SharedBank container flagged guild (`epgp.bank.manage`-gated
`PUT /api/officer/bank/designations`, re-checked server-side by
`validateSyncPayload` — never trusts the app's own filtering alone); every
other member's SharedBank rows are simply never part of its own sync
payload.

## Mule vs. hybrid alt — resolved: container-level, at designation time

Not every holder character is necessarily a pure mule — an alt might carry
guild bank items in some bags/tabs and the player's own gear in others.
Went with the container-level design (the recommended option from this
file's earlier draft): a new `bank_slot_designations` table holds one row
per top-level container (`General1`-`General8`, `Bank1`-`Bank30` per
character; `SharedBank1`-`SharedBank10` per EQ account group) that's been
explicitly flagged guild — a row existing means guild, no row means
personal, so a character starts out fully personal and an officer opts
specific containers in via the Guild Bank tab's per-bag toggle. Personal
items in a non-designated container are never even sent to the server —
`bankexport.BuildSyncRows` is the only thing that turns a designated
container's contents into upload rows, and only for containers actually
flagged guild.

Survives re-import cleanly: the designation lives on the character/account,
not on the volatile row data that gets deleted and reinserted every sync
(`applySync` in `src/lib/bank/sync.ts`) — a `note`/`status` an officer set
on a specific imported row (task 8.6-style row edit) is carried over to the
new row at the same `(container, slotIndex)` if the item there is
unchanged, so that doesn't get wiped by a routine re-sync either.

## Sync path

`POST /api/officer/bank/sync` (`src/app/api/officer/bank/sync/route.ts`,
`src/lib/bank/sync.ts`) — delete-and-replace per holder, same idempotent
shape `scripts/import-sos-bot-dump.ts` and friends use, but reachable from
the officer app instead of run by hand: every holder's existing
`source='import'` non-currency rows are deleted and the new set inserted in
one transaction, with a `bank_imports` row recording who/when/how many
rows/whether this sync carried the account's SharedBank. A manual row
(`source='manual'`) and any currency row are never touched by a sync,
regardless of what's in the payload. `dryRun: true` runs the exact same
diff logic and writes nothing — the app's "Preview sync" step.

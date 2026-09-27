// 2026-09-27: no longer a constant someone has to remember to flip.
// bank/page.tsx now derives the "under construction" banner automatically
// from whether any unverified (sheet/manual) rows remain anywhere
// (src/lib/bank/sync.ts's hasUnverifiedBankRows) — the sheet-to-sync
// transition being "done" IS "nothing left unverified," so the banner
// disappears the moment that's actually true instead of on whatever day
// someone remembers to edit this file.

// 2026-09-27, Jason's own call: with the officer app's real sync now
// covering everyone who could legitimately add guild bank items (an
// officer's own characters, or an alt/mule of one — anyone else adding
// items by hand is exactly the case the unverified-item reconciliation
// exists to guard against), the manual "+ Add item" entry point on /bank
// is more risk than it's worth for now. The backend
// (createManualHolding/addManualHoldingAction) is untouched and still
// fully exercised by editing/removing an EXISTING row — this only hides
// the button/form that CREATES a new one, so sync stays the one real
// source of new guild bank items. Flip back to true if a real case for
// manual add comes up again.
export const BANK_MANUAL_ADD_ENABLED = false;

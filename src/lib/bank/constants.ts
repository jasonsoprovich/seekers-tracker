// 2026-09-27: no longer a constant someone has to remember to flip.
// bank/page.tsx now derives the "under construction" banner automatically
// from whether any unverified (sheet/manual) rows remain anywhere
// (src/lib/bank/sync.ts's hasUnverifiedBankRows) — the sheet-to-sync
// transition being "done" IS "nothing left unverified," so the banner
// disappears the moment that's actually true instead of on whatever day
// someone remembers to edit this file.

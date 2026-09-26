// Set to false once the guild bank sync has been through a full officer
// testing round and the sheet-to-sync transition is finished (PLAN.md §9).
// Drives the red "under construction" banner on /bank — 2026-09-25 officer
// feedback: while designations/sheet retirement/live resyncs are still in
// flux, members should see a clear warning rather than assume the numbers
// are final.
export const BANK_UNDER_CONSTRUCTION = true;

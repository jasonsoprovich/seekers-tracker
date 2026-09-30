// Shared by the ledger page (reads the cookie) and PageSizeSelect (renders
// the options). Not in actions.ts: a "use server" file may only export
// async functions.
export const LEDGER_PAGE_SIZES = [50, 100, 150, 200] as const;
export const LEDGER_PAGE_SIZE_COOKIE = "ledger_page_size";
export const DEFAULT_LEDGER_PAGE_SIZE = 50;

export function parseLedgerPageSize(raw: string | undefined): number {
  const n = Number(raw);
  return (LEDGER_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_LEDGER_PAGE_SIZE;
}

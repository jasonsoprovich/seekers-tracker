"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { setLedgerPageSize } from "@/app/(app)/epgp/ledger/actions";
import { LEDGER_PAGE_SIZES } from "@/app/(app)/epgp/ledger/page-size";
import { fieldClasses } from "@/components/ui/Field";

// Rows-per-page dropdown for the ledger tabs. Saves to a session cookie
// (server action) then returns to page 1, since the old page number no
// longer lines up with the new page size.
export function PageSizeSelect({ value }: { value: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function onChange(size: number) {
    startTransition(async () => {
      await setLedgerPageSize(size);
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", "1");
      router.replace(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <label className="flex items-center gap-2 text-sm text-neutral-400">
      Rows per page
      <select
        value={value}
        disabled={pending}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${fieldClasses({ size: "sm" })} w-20`}
      >
        {LEDGER_PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

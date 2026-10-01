"use client";

import { createContext, useContext, type ReactNode } from "react";

// Whether the admin has switched PQDI item tooltips on (Admin → Site
// features). Read once in the (app) layout; ItemLink renders plain text when
// this is false, so a disabled feature does no network work at all.
const Ctx = createContext(false);

export function ItemTooltipsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <Ctx.Provider value={enabled}>{children}</Ctx.Provider>;
}

export function useItemTooltipsEnabled(): boolean {
  return useContext(Ctx);
}

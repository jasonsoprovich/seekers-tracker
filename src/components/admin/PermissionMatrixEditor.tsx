"use client";

import { useMemo, useState } from "react";

import { resetPermissionsToDefaults, savePermissionMatrix } from "@/app/(app)/admin/permissions/actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
// From the dependency-free capabilities module, not the "@/lib/permissions"
// barrel — that barrel re-exports src/lib/authz.ts's getUserRole, which
// imports next/headers and can't be pulled into a client bundle (see
// capabilities.ts's own comment on why it's kept import-safe).
import { MATRIX_ROLES, type Capability, type CapabilityGroup, type MatrixRole } from "@/lib/permissions/capabilities";

type Row = {
  key: Capability;
  label: string;
  description: string;
  lockedRoles: readonly MatrixRole[];
  effective: Record<MatrixRole, boolean>;
  defaults: Record<MatrixRole, boolean>;
};

const ROLE_LABEL: Record<MatrixRole, string> = { member: "Member", officer: "Officer", leader: "Leader" };

// The admin-only editor behind /admin/permissions. Dirty-tracked: toggling
// a cell only updates local state until "Save changes" — the server action
// (savePermissionMatrix) re-validates every capability/role/lockedRoles
// server-side regardless, so a disabled checkbox here is a UX nicety, not
// the actual guarantee.
export function PermissionMatrixEditor({ groups }: { groups: { group: CapabilityGroup; rows: Row[] }[] }) {
  // capability -> role -> current (possibly unsaved) value. Seeded from each
  // row's effective value once, on first render.
  const [values, setValues] = useState<Record<string, Record<MatrixRole, boolean>>>(() => {
    const init: Record<string, Record<MatrixRole, boolean>> = {};
    for (const { rows } of groups) for (const row of rows) init[row.key] = { ...row.effective };
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const dirtyCells = useMemo(() => {
    const cells: { capability: string; role: string; allowed: boolean }[] = [];
    for (const row of allRows) {
      for (const role of MATRIX_ROLES) {
        if (values[row.key][role] !== row.effective[role]) {
          cells.push({ capability: row.key, role, allowed: values[row.key][role] });
        }
      }
    }
    return cells;
  }, [allRows, values]);

  function toggle(key: Capability, role: MatrixRole, locked: boolean) {
    if (locked || saving) return;
    setValues((v) => ({ ...v, [key]: { ...v[key], [role]: !v[key][role] } }));
    setSavedAt(null);
  }

  async function save() {
    if (dirtyCells.length === 0) return;
    setSaving(true);
    setError(null);
    const result = await savePermissionMatrix(dirtyCells);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSavedAt(Date.now());
  }

  async function resetAll() {
    setResetting(true);
    setError(null);
    const result = await resetPermissionsToDefaults();
    setResetting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const init: Record<string, Record<MatrixRole, boolean>> = {};
    for (const row of allRows) init[row.key] = { ...row.defaults };
    setValues(init);
    setSavedAt(Date.now());
  }

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:mx-0 sm:rounded-lg sm:border">
        <Button type="button" size="sm" onClick={save} disabled={dirtyCells.length === 0 || saving}>
          {saving ? "Saving…" : dirtyCells.length > 0 ? `Save changes (${dirtyCells.length})` : "Save changes"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetAll} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset all to defaults"}
        </Button>
        {error && <span className="text-sm text-red-400">{error}</span>}
        {!error && savedAt && dirtyCells.length === 0 && <span className="text-sm text-emerald-400">Saved.</span>}
      </div>

      {groups.map(({ group, rows }) => (
        <section key={group} className="mt-8 first:mt-0">
          <h2 className="text-lg font-semibold">{group}</h2>
          <Card className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs tracking-wider text-neutral-500 uppercase">
                  <th className="px-4 py-2 font-medium">Capability</th>
                  {MATRIX_ROLES.map((role) => (
                    <th key={role} className="px-3 py-2 text-center font-medium">
                      {ROLE_LABEL[role]}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center font-medium">Admin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 align-top">
                      <p className="font-medium text-neutral-200">{row.label}</p>
                      <p className="mt-0.5 text-xs text-neutral-500">{row.description}</p>
                    </td>
                    {MATRIX_ROLES.map((role) => {
                      const locked = row.lockedRoles.includes(role);
                      const checked = values[row.key][role];
                      const changed = checked !== row.defaults[role];
                      return (
                        <td key={role} className="px-3 py-3 text-center align-top">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked || saving}
                            onChange={() => toggle(row.key, role, locked)}
                            title={locked ? `${ROLE_LABEL[role]} can't be granted this — too destructive to hand out from here.` : undefined}
                            className="h-4 w-4 accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          {changed && <span className="mt-1 block text-[10px] text-amber-400">changed</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-3 text-center align-top">
                      <input type="checkbox" checked disabled className="h-4 w-4 accent-emerald-500 opacity-60" title="Admin can always do everything." />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ))}
    </div>
  );
}

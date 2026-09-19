"use client";

import { useMemo, useState } from "react";

import { createCharacterForAccount } from "@/app/(app)/characters/[id]/account/actions";
import { CharacterForm } from "@/components/CharacterForm";
import { Card } from "@/components/ui/Card";

// "Add a character to this account" — sits next to LinkToAccountPanel
// (which only attaches an EXISTING unclaimed roster character) for the
// other half of the 2026-09-19 guild leader request: a character that has
// never appeared on the roster at all. Collapsed by default, same shape as
// LinkToAccountPanel, so the account page doesn't grow a permanently-open
// form most visits don't need.
export function AddCharacterToAccountPanel({
  playerId,
  accountName,
  mainCharacterId,
  mainCharacterName,
}: {
  playerId: number;
  accountName: string;
  mainCharacterId: number | null;
  mainCharacterName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const boundAction = createCharacterForAccount.bind(null, playerId);

  // A single-entry "candidate" list so the form's existing main-character
  // select shows the real name instead of an empty "Not linked yet" — the
  // server never trusts this value anyway (createCharacterForAccount always
  // derives the link from the account itself), so there's nothing else to
  // offer a picker over.
  const mainCandidates = useMemo(
    () => (mainCharacterId !== null && mainCharacterName !== null ? [{ id: mainCharacterId, name: mainCharacterName, ownerUsername: accountName }] : []),
    [mainCharacterId, mainCharacterName, accountName],
  );

  return (
    <Card className="mt-6 px-4 py-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <span className="font-medium text-neutral-100">Add a character to {accountName}</span>
        <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-sm text-neutral-400">
            For a character that has never been on the roster — an unclaimed existing character should be linked above instead.{" "}
            {mainCharacterId !== null
              ? "This adds an alt or mule to this account."
              : "This account has no main yet, so add its main from Your Characters → Add Character first, then come back here for alts."}
          </p>
          <div className="mt-3">
            <CharacterForm
              action={boundAction}
              submitLabel="Add character"
              defaultCharType="alt"
              mainCandidates={mainCandidates}
              defaultMainCharacterId={mainCharacterId}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

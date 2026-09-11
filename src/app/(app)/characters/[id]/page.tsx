import { redirect } from "next/navigation";

// A character's landing page is its Account tab (leader, 2026-09-11):
// clicking a name anywhere on the site should show the account — main,
// alts, EP/GP — not the PoP checklist, which now lives at ./pop.
export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/characters/${id}/account`);
}

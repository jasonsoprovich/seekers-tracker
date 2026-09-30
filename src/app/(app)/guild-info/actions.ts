"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/lib/db";
import {
  createGuildInfoCard,
  deleteGuildInfoCard,
  moveGuildInfoCard,
  setGuildInfoCardWidth,
  updateGuildInfoCard,
  type CardWidth,
} from "@/lib/guild-info";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

export type GuildInfoResult = { error?: string };

// Every action re-checks "guild.info.edit" itself — the page only hides the
// controls, it is not the gate.
async function requireEditor(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };
  const perms = await getPermissions(session.user.id);
  if (!perms.can("guild.info.edit")) return { error: "Only guild leaders and admins can edit this page." };
  return { userId: session.user.id };
}

function isWidth(v: string): v is CardWidth {
  return v === "full" || v === "half";
}

function done(result: GuildInfoResult): GuildInfoResult {
  if (!result.error) revalidatePath("/guild-info");
  return result;
}

export async function createCardAction(title: string, body: string, width: string): Promise<GuildInfoResult> {
  const auth = await requireEditor();
  if ("error" in auth) return auth;
  if (!isWidth(width)) return { error: "Invalid width." };
  const result = await createGuildInfoCard(await getDb(), { title, body, width }, auth.userId);
  return done("error" in result ? { error: result.error } : {});
}

export async function updateCardAction(id: number, title: string, body: string): Promise<GuildInfoResult> {
  const auth = await requireEditor();
  if ("error" in auth) return auth;
  return done(await updateGuildInfoCard(await getDb(), id, { title, body }, auth.userId));
}

export async function setCardWidthAction(id: number, width: string): Promise<GuildInfoResult> {
  const auth = await requireEditor();
  if ("error" in auth) return auth;
  if (!isWidth(width)) return { error: "Invalid width." };
  return done(await setGuildInfoCardWidth(await getDb(), id, width, auth.userId));
}

export async function moveCardAction(id: number, direction: string): Promise<GuildInfoResult> {
  const auth = await requireEditor();
  if ("error" in auth) return auth;
  if (direction !== "up" && direction !== "down") return { error: "Invalid direction." };
  return done(await moveGuildInfoCard(await getDb(), id, direction, auth.userId));
}

export async function deleteCardAction(id: number): Promise<GuildInfoResult> {
  const auth = await requireEditor();
  if ("error" in auth) return auth;
  return done(await deleteGuildInfoCard(await getDb(), id, auth.userId));
}

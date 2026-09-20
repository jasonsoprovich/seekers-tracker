import assert from "node:assert/strict";

import { visibleLiveBidRounds } from "../src/lib/live-bids/protocol";
import { effectiveRoleWithViewAs, viewAsRoleFromCookieHeader } from "../src/lib/view-as";

type FixtureRound = {
  name: string;
  state: "collecting" | "resolved";
  startedAt: number;
  lastSeenAt: number;
};

const rounds: FixtureRound[] = [
  { name: "resolved-new", state: "resolved", startedAt: 40, lastSeenAt: 400 },
  { name: "collecting-new", state: "collecting", startedAt: 30, lastSeenAt: 100 },
  { name: "resolved-old", state: "resolved", startedAt: 20, lastSeenAt: 500 },
  { name: "collecting-old", state: "collecting", startedAt: 10, lastSeenAt: 50 },
];
const sourceOrder = rounds.map((round) => round.name);

assert.deepEqual(
  visibleLiveBidRounds(rounds).map((round) => round.name),
  ["collecting-old", "collecting-new", "resolved-old", "resolved-new"],
);
rounds[3].lastSeenAt = 10_000;
rounds[1].lastSeenAt = 1;
assert.deepEqual(
  visibleLiveBidRounds(rounds).map((round) => round.name),
  ["collecting-old", "collecting-new", "resolved-old", "resolved-new"],
  "heartbeat/bid activity must not reorder rounds",
);
assert.equal(visibleLiveBidRounds(rounds).filter((round) => round.state === "collecting").length, 2, "all detail modes retain open rounds");
assert.deepEqual(rounds.map((round) => round.name), sourceOrder, "ordering must not mutate DO state");

assert.equal(viewAsRoleFromCookieHeader("other=1; seekers_view_as_role=leader"), "leader");
assert.equal(viewAsRoleFromCookieHeader("seekers_view_as_role=admin"), null);
assert.equal(effectiveRoleWithViewAs("admin", "seekers_view_as_role=officer"), "officer");
assert.equal(effectiveRoleWithViewAs("admin", "seekers_view_as_role=leader"), "leader");
assert.equal(effectiveRoleWithViewAs("leader", "seekers_view_as_role=member"), "leader");

console.log("Live-bid protocol verification passed.");

export type LiveBidRoundState = "collecting" | "resolved";

export function visibleLiveBidRounds<T extends { state: LiveBidRoundState; startedAt: number }>(
  rounds: Iterable<T>,
): T[] {
  return [...rounds]
    .sort((a, b) => {
      const stateOrder = Number(a.state === "resolved") - Number(b.state === "resolved");
      return stateOrder || a.startedAt - b.startedAt;
    });
}

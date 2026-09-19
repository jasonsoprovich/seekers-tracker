export type LiveBidRoundState = "collecting" | "resolved";

export function visibleLiveBidRounds<T extends { state: LiveBidRoundState; startedAt: number }>(
  rounds: Iterable<T>,
  showCollecting: boolean,
): T[] {
  return [...rounds]
    .filter((round) => showCollecting || round.state === "resolved")
    .sort((a, b) => {
      const stateOrder = Number(a.state === "resolved") - Number(b.state === "resolved");
      return stateOrder || a.startedAt - b.startedAt;
    });
}

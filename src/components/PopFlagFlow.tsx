"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PopFlagRow } from "@/components/PopFlagRow";
import { tierLabel, zoneColor, ZONE_ORDER, type FlagStatus } from "@/lib/pop-flags";

// Tiered, zone-grouped flowchart of the PoP flags, ported from pq-companion's
// PoPFlagFlowPanel (shaped like Grimrose's hand-verified flagging chart): one
// band per tier, one card per zone in ZONE_ORDER, each card listing its steps
// like the checklist. Arrows connect a whole ZONE to the zone(s) it unlocks,
// with an "ALL" badge where 2+ zones must all be done first. Layout is plain
// flex; arrows are one SVG overlay computed from the cards' measured rects.

interface ZoneGroup {
  zone: string;
  tier: number;
  flags: FlagStatus[];
}

type ZoneStatus = "done" | "available" | "locked";

function zoneStatus(flags: FlagStatus[]): ZoneStatus {
  const relevant = flags.filter((f) => !f.optional && !f.group);
  if (relevant.length === 0) return "available";
  if (relevant.every((f) => f.done)) return "done";
  if (relevant.every((f) => f.locked && !f.done)) return "locked";
  return "available";
}

const STATUS_BORDER: Record<ZoneStatus, string> = {
  done: "rgb(52 211 153)",
  available: "rgb(64 64 64)",
  locked: "rgba(248,113,113,0.45)",
};

interface Point {
  x: number;
  y: number;
}

function anchorPoints(from: DOMRect, to: DOMRect): { from: Point; to: Point; vertical: boolean } {
  const fc = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const tc = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const dy = tc.y - fc.y;
  const dx = tc.x - fc.x;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? { from: { x: fc.x, y: from.bottom }, to: { x: tc.x, y: to.top }, vertical: true }
      : { from: { x: fc.x, y: from.top }, to: { x: tc.x, y: to.bottom }, vertical: true };
  }
  return dx >= 0
    ? { from: { x: from.right, y: fc.y }, to: { x: to.left, y: tc.y }, vertical: false }
    : { from: { x: from.left, y: fc.y }, to: { x: to.right, y: tc.y }, vertical: false };
}

function curvePath(from: Point, to: Point, vertical: boolean): string {
  if (vertical) {
    const midY = (from.y + to.y) / 2;
    return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
  }
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

interface EdgePath {
  key: string;
  from: string;
  to: string;
  d: string;
}

interface JoinBadge {
  zone: string;
  pos: Point;
}

export default function PopFlagFlow({
  flags,
  readOnly,
  busyId,
  requiredByDone,
  onToggle,
}: {
  flags: FlagStatus[];
  readOnly: boolean;
  busyId: string | null;
  requiredByDone: Set<string>;
  onToggle: (flag: FlagStatus) => void;
}) {
  const zones = useMemo<ZoneGroup[]>(() => {
    const byZone = new Map<string, ZoneGroup>();
    const firstSeen: string[] = [];
    for (const f of flags) {
      let g = byZone.get(f.zone);
      if (!g) {
        g = { zone: f.zone, tier: f.tier, flags: [] };
        byZone.set(f.zone, g);
        firstSeen.push(f.zone);
      }
      g.flags.push(f);
    }
    const order = [...ZONE_ORDER, ...firstSeen.filter((z) => !ZONE_ORDER.includes(z))];
    return order.filter((z) => byZone.has(z)).map((z) => byZone.get(z)!);
  }, [flags]);

  const tiers = useMemo(() => {
    const byTier = new Map<number, ZoneGroup[]>();
    for (const z of zones) {
      if (!byTier.has(z.tier)) byTier.set(z.tier, []);
      byTier.get(z.tier)!.push(z);
    }
    return [...byTier.entries()].sort((a, b) => a[0] - b[0]);
  }, [zones]);

  // Cross-zone prereq edges, deduped to (sourceZone -> targetZone); a target
  // fed by 2+ distinct zones gets an "ALL" badge.
  const { edgeList, joinZones } = useMemo(() => {
    const zoneOf = new Map(flags.map((f) => [f.id, f.zone]));
    const incoming = new Map<string, Set<string>>();
    for (const f of flags) {
      for (const p of f.prereqs) {
        const src = zoneOf.get(p);
        if (!src || src === f.zone) continue;
        if (!incoming.has(f.zone)) incoming.set(f.zone, new Set());
        incoming.get(f.zone)!.add(src);
      }
    }
    const list: { from: string; to: string }[] = [];
    const joins = new Set<string>();
    for (const [to, froms] of incoming) {
      if (froms.size > 1) joins.add(to);
      for (const from of froms) list.push({ from, to });
    }
    return { edgeList: list, joinZones: joins };
  }, [flags]);

  const [focusedZone, setFocusedZone] = useState<string | null>(null);
  const inFocus = useMemo(() => {
    if (!focusedZone) return null;
    const s = new Set<string>([focusedZone]);
    for (const e of edgeList) {
      if (e.from === focusedZone) s.add(e.to);
      if (e.to === focusedZone) s.add(e.from);
    }
    return s;
  }, [focusedZone, edgeList]);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const setCardRef = useCallback(
    (zone: string) => (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(zone, el);
      else cardRefs.current.delete(zone);
    },
    [],
  );

  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [badges, setBadges] = useState<JoinBadge[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const recompute = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const cRect = content.getBoundingClientRect();
    setSvgSize({ w: content.scrollWidth, h: content.scrollHeight });

    const rel = (p: Point): Point => ({ x: p.x - cRect.left, y: p.y - cRect.top });
    const nextPaths: EdgePath[] = [];
    for (const e of edgeList) {
      const fromEl = cardRefs.current.get(e.from);
      const toEl = cardRefs.current.get(e.to);
      if (!fromEl || !toEl) continue;
      const { from, to, vertical } = anchorPoints(fromEl.getBoundingClientRect(), toEl.getBoundingClientRect());
      nextPaths.push({ key: `${e.from}->${e.to}`, from: e.from, to: e.to, d: curvePath(rel(from), rel(to), vertical) });
    }
    setPaths(nextPaths);

    const nextBadges: JoinBadge[] = [];
    for (const zone of joinZones) {
      const el = cardRefs.current.get(zone);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      nextBadges.push({ zone, pos: { x: r.left - cRect.left + r.width / 2, y: r.top - cRect.top - 9 } });
    }
    setBadges(nextBadges);
  }, [edgeList, joinZones]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, zones]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(content);
    window.addEventListener("resize", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-neutral-500">
          Arrows connect a zone to what it unlocks. Click a zone&apos;s header to highlight what feeds it and what it
          feeds; click again to reset.
        </p>
        {joinZones.size > 0 && (
          <span className="ml-auto shrink-0 rounded border border-orange-400/40 bg-orange-400/10 px-1.5 py-0.5 text-[10px] tracking-wider text-orange-400 uppercase">
            ALL = every source zone required
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
        <div ref={contentRef} className="relative flex min-w-max flex-col gap-8 pt-3">
          <svg
            width={svgSize.w}
            height={svgSize.h}
            style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
            aria-hidden
          >
            <defs>
              <marker id="popflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280" />
              </marker>
            </defs>
            {paths.map((p) => {
              const dimmed = inFocus ? !(inFocus.has(p.from) && inFocus.has(p.to)) : false;
              return (
                <path
                  key={p.key}
                  d={p.d}
                  fill="none"
                  stroke="#6b7280"
                  strokeWidth={1.5}
                  opacity={dimmed ? 0.08 : 0.75}
                  markerEnd="url(#popflow-arrow)"
                />
              );
            })}
          </svg>
          {badges.map((b) => (
            <div
              key={b.zone}
              style={{
                position: "absolute",
                left: b.pos.x,
                top: b.pos.y,
                transform: "translate(-50%, -100%)",
                opacity: inFocus && !inFocus.has(b.zone) ? 0.15 : 1,
                pointerEvents: "none",
              }}
              className="rounded bg-neutral-950 px-1.5 text-[9px] font-bold tracking-wider text-orange-400 uppercase"
            >
              ALL
            </div>
          ))}

          {tiers.map(([tier, tierZones]) => (
            <div key={tier} className="flex items-stretch gap-3">
              <div
                className="flex w-5 shrink-0 items-center justify-center text-[10px] font-bold tracking-widest text-neutral-500 uppercase"
                style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
              >
                {tierLabel(tier)}
              </div>
              <div className="flex flex-1 flex-nowrap items-start gap-x-5">
                {tierZones.map((z) => {
                  const status = zoneStatus(z.flags);
                  const dimmed = inFocus ? !inFocus.has(z.zone) : false;
                  const accent = zoneColor(z.zone);
                  return (
                    <div
                      key={z.zone}
                      ref={setCardRef(z.zone)}
                      className="flex w-[240px] shrink-0 flex-col overflow-hidden rounded-lg bg-neutral-900"
                      style={{
                        border: `1px solid ${STATUS_BORDER[status]}`,
                        opacity: dimmed ? 0.25 : 1,
                        transition: "opacity 0.15s ease",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setFocusedZone((cur) => (cur === z.zone ? null : z.zone))}
                        className="flex items-center justify-between px-2.5 py-1.5 text-left"
                        style={{ backgroundColor: `${accent}26`, borderBottom: `2px solid ${accent}` }}
                        title="Click to highlight what feeds this zone and what it unlocks"
                      >
                        <span className="text-[11px] font-semibold" style={{ color: accent }}>
                          {z.zone}
                        </span>
                      </button>
                      <div className="flex-1">
                        {z.flags.map((f) => (
                          <PopFlagRow
                            key={f.id}
                            flag={f}
                            allFlags={flags}
                            requiredByDone={requiredByDone}
                            busy={busyId === f.id}
                            readOnly={readOnly}
                            onToggle={onToggle}
                            compact
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

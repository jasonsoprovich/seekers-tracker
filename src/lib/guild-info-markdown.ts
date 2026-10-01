// Pure text normalizer for Guild Information card bodies. Leaders paste from
// Discord, whose tab-indented "•" bullets are, to Markdown, *indented code
// blocks* — which is what turned the EPGP Loot Guide into a monospace wall
// with literal ** marks. This turns that paste into real nested lists,
// keeps fenced ``` blocks untouched, and makes extra blank lines meaningful.
//
// Dependency-free so scripts/verify-guild-markdown.ts can test it directly.

export const SPACER_LINE = ":::spacer";

const BULLET = /^(\s*)(?:[•·▪‣◦●]|[-*+](?=\s))\s*(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const BLOCK_START = /^(\s*)(#{1,6}\s|>|---+\s*$|\*\*\*+\s*$|\|)/;

// Discord pastes often have "** Heading**" (space after the opening **),
// which Markdown refuses to treat as bold.
function fixLooseBold(line: string): string {
  return line.replace(/\*\*[ \t]+([^*\n]+?)[ \t]*\*\*/g, "**$1**").replace(/\*\*([^*\n]+?)[ \t]+\*\*/g, "**$1**");
}

// [[Item Name]] -> a link our renderer turns into an item tooltip link.
// Parentheses are percent-encoded so they can't end the link early.
function itemTokens(line: string): string {
  return line.replace(/\[\[([^\]\n]+)\]\]/g, (_m, name: string) => {
    const enc = encodeURIComponent(name.trim()).replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[${name.trim()}](#item=${enc})`;
  });
}

function normalizeChunk(chunk: string): string {
  const lines = chunk.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const out: string[] = [];
  // Distinct indent widths seen for the current run of list lines; a line's
  // nesting level is the index of its width, so "•" at 4 spaces and "•" at
  // 8 spaces nest regardless of how many spaces Discord used.
  let indents: number[] = [];
  let blanks = 0;

  const levelFor = (width: number): number => {
    while (indents.length && indents[indents.length - 1] > width) indents.pop();
    const at = indents.indexOf(width);
    if (at >= 0) return at;
    indents.push(width);
    return indents.length - 1;
  };

  for (const raw of lines) {
    if (!raw.trim()) {
      blanks++;
      continue;
    }
    // Blank-line run: 1 blank = paragraph break, each extra blank = a spacer.
    if (out.length) {
      if (blanks === 0) {
        // same block; hard break added below when needed
      } else {
        out.push("");
        for (let i = 1; i < blanks; i++) out.push(SPACER_LINE, "");
      }
    }
    const hadBlank = blanks > 0;
    blanks = 0;

    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    if (bullet && !/^(\s*)[-*+]\s*$/.test(raw) && !/^\s*(\*\*|---)/.test(raw)) {
      const level = levelFor(bullet[1].length);
      out.push(`${"  ".repeat(level)}- ${itemTokens(fixLooseBold(bullet[2]))}`);
      continue;
    }
    if (numbered) {
      const level = levelFor(numbered[1].length);
      out.push(`${"   ".repeat(level)}${numbered[2]} ${itemTokens(fixLooseBold(numbered[3]))}`);
      continue;
    }
    indents = [];
    // Indented non-list text must never become an indented code block.
    const text = itemTokens(fixLooseBold(raw.replace(/^\s+/, "")));
    const prev = out[out.length - 1];
    const prevIsBreakable = prev !== undefined && prev !== "" && !hadBlank && !BLOCK_START.test(prev) && prev !== SPACER_LINE;
    if (prevIsBreakable) out[out.length - 1] = `${prev.replace(/ {2}$/, "")}  `;
    out.push(text);
  }
  return out.join("\n");
}

export function normalizeGuildMarkdown(src: string): string {
  return src
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : normalizeChunk(part)))
    .join("");
}

// Splits normalized text at spacer markers so each run can render as its own
// Markdown document with a visible gap between them. Empty chunks are kept
// (two spacers in a row = two gaps); the renderer skips rendering them.
export function splitSpacers(normalized: string): string[] {
  return normalized.split(new RegExp(`^${SPACER_LINE}$`, "m")).map((s) => s.trim());
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

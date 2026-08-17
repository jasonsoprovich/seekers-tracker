// Minimal RFC4180 CSV parser for Google Sheets' gviz CSV export (§10) —
// handles quoted fields, embedded commas/newlines, and "" escaping. No
// external dependency for something this small.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// Builds { normalizedHeader -> columnIndex } so callers can look up columns
// by header text rather than fixed position — the sheet has already been
// observed to drift (stray leading columns, mislabeled headers), see §10's
// "Known fragility" note.
export function headerIndex(headerRow: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const normalized = h.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized) map.set(normalized, i);
  });
  return map;
}

export function findColumn(headers: Map<string, number>, candidates: string[]): number | undefined {
  for (const candidate of candidates) {
    const idx = headers.get(candidate);
    if (idx !== undefined) return idx;
  }
  return undefined;
}

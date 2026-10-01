// Client-only: turns PQDI's tooltip HTML fragment into a safe, self-styled
// one. Nothing from the fragment is trusted — we walk it and rebuild a new
// tree from an allowlist of tags and a tiny set of attributes, with every
// URL forced onto https://www.pqdi.cc (the fragment uses relative /static/…
// icon paths and /spell/… links — the "hacking in transit" the PQDI author
// mentioned). Their classes/inline styles are dropped; styling is ours
// (.pqdi-tip in globals.css).

const ORIGIN = "https://www.pqdi.cc";
const TAGS = new Set(["div", "table", "tbody", "tr", "td", "th", "h4", "b", "strong", "i", "em", "br", "span", "img", "a", "p", "ul", "li"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "svg", "form", "input", "button"]);

function pqdiUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, `${ORIGIN}/`);
    return u.origin === ORIGIN ? u.href : null;
  } catch {
    return null;
  }
}

// The item icon is a sprite: background-image + background-position + size.
function iconStyle(style: string): string | null {
  const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style)?.[1];
  const abs = pqdiUrl(url ?? null);
  if (!abs) return null;
  const pos = /background-position\s*:\s*(-?\d+(?:px)?)\s+(-?\d+(?:px)?)/i.exec(style);
  const px = (v: string) => (v.endsWith("px") ? v : `${v}px`);
  const position = pos ? `${px(pos[1])} ${px(pos[2])}` : "0 0";
  return `background-image:url("${abs}");background-position:${position};`;
}

function clean(src: Node, out: Node, doc: Document) {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!TAGS.has(tag)) {
      clean(el, out, doc); // unwrap unknown elements, keep their text
      continue;
    }
    const next = doc.createElement(tag);
    if (tag === "div" && Array.from(el.children).some((c) => c.tagName === "H4")) next.className = "pqdi-head";
    if (tag === "span" && el.classList.contains("item-icon")) {
      next.className = "pqdi-icon";
      const style = iconStyle(el.getAttribute("style") ?? "");
      if (style) next.setAttribute("style", style);
    }
    if ((tag === "td" || tag === "th") && el.getAttribute("colspan")?.match(/^\d{1,2}$/)) next.setAttribute("colspan", el.getAttribute("colspan")!);
    if (tag === "img") {
      const src2 = pqdiUrl(el.getAttribute("src"));
      if (!src2) continue;
      next.setAttribute("src", src2);
      next.setAttribute("alt", "");
      next.setAttribute("width", "14");
      next.setAttribute("height", "14");
    }
    if (tag === "a") {
      const href = pqdiUrl(el.getAttribute("href"));
      if (href) {
        next.setAttribute("href", href);
        next.setAttribute("target", "_blank");
        next.setAttribute("rel", "noopener noreferrer");
      }
    }
    clean(el, next, doc);
    out.appendChild(next);
  }
}

export function sanitizeTooltip(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = parsed.implementation.createHTMLDocument("");
  const root = out.createElement("div");
  clean(parsed.body, root, out);
  return root.innerHTML;
}

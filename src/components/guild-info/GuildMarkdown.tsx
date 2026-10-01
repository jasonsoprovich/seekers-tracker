import Markdown from "markdown-to-jsx/react";
import { Fragment } from "react";

import { ItemLink } from "@/components/items/ItemLink";
import { normalizeGuildMarkdown, splitSpacers } from "@/lib/guild-info-markdown";

// Renders leader-written Markdown. Raw HTML is never parsed (it renders as
// plain text). Input is normalized first (src/lib/guild-info-markdown.ts):
// Discord-pasted bullets become real lists, single newlines are line
// breaks, and each extra blank line becomes a visible gap. `[[Item Name]]`
// becomes an item link (a PQDI tooltip when the admin has them on, plain
// text otherwise). External links open in a new tab; in-page "#anchor"
// links scroll to the matching card.
function GuildLink({ href, children, ...rest }: React.ComponentProps<"a">) {
  if (href?.startsWith("#item=")) {
    const name = decodeURIComponent(href.slice("#item=".length));
    return <ItemLink name={name}>{children}</ItemLink>;
  }
  if (href?.startsWith("#")) return <a href={href} {...rest}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function GuildMarkdown({ children }: { children: string }) {
  const parts = splitSpacers(normalizeGuildMarkdown(children));
  return (
    <div className="guild-md">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="guild-md-spacer" aria-hidden />}
          {part && (
            <Markdown options={{ disableParsingRawHTML: true, forceWrapper: true, wrapper: Fragment, overrides: { a: { component: GuildLink } } }}>{part}</Markdown>
          )}
        </Fragment>
      ))}
    </div>
  );
}

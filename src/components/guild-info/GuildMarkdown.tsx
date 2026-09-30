import Markdown from "markdown-to-jsx/react";

// Discord-style line breaks: a single newline is a line break (standard
// Markdown would fold it into the previous line). Blank lines still split
// paragraphs, and fenced code blocks are left exactly as typed.
function discordBreaks(src: string): string {
  return src
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([^\n])\n(?=[^\n])/g, "$1  \n")))
    .join("");
}

// Renders leader-written Markdown. Raw HTML is never parsed (it renders as
// plain text), and links always open in a new tab with noopener.
export function GuildMarkdown({ children }: { children: string }) {
  return (
    <div className="guild-md">
      <Markdown
        options={{
          disableParsingRawHTML: true,
          overrides: {
            a: { props: { target: "_blank", rel: "noopener noreferrer" } },
          },
        }}
      >
        {discordBreaks(children)}
      </Markdown>
    </div>
  );
}

"use client";

import { useEffect } from "react";

import { handleChunkLoadError } from "@/lib/chunk-reload";

// Root-level error boundary — replaces the whole document when a render
// error escapes every nested boundary (including the root layout). Its main
// job here is deploy-skew recovery: a tab still on the previous build throws
// ChunkLoadError trying to load a chunk that no longer exists, and one
// automatic reload pulls the current build. A sessionStorage guard in
// handleChunkLoadError stops it looping if the reload doesn't help.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    handleChunkLoadError(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#e5e5e5",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Something went wrong</h1>
          <p style={{ marginTop: "0.75rem", color: "#a3a3a3", fontSize: "0.9rem" }}>
            Reloading usually fixes it. If it keeps happening, let a leader know.
          </p>
          <div
            style={{
              marginTop: "1.5rem",
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                borderRadius: 9999,
                background: "#10b981",
                color: "#000",
                padding: "0.5rem 1.25rem",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                borderRadius: 9999,
                background: "transparent",
                color: "#e5e5e5",
                padding: "0.5rem 1.25rem",
                fontWeight: 600,
                border: "1px solid #404040",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

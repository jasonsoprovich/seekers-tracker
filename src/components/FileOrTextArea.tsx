"use client";

import { useRef, useState, type DragEvent } from "react";

// Generous for these payloads (a Seer paste or a Quarmy export is a few KB;
// a pq-companion export JSON tops out well under this too) — just enough
// headroom to reject an obviously-wrong file without risking a real export.
const MAX_BYTES = 512 * 1024;

interface FileOrTextAreaProps {
  name: string;
  required?: boolean;
  rows: number;
  placeholder: string;
  /** Comma-separated extensions, e.g. ".txt" or ".json" — used for both the file picker's `accept` and client-side validation. */
  accept: string;
  /** Short noun for the drop-zone copy, e.g. "a .txt" or "a .json". */
  fileHint: string;
  className: string;
}

// A textarea that doubles as a file drop zone / picker. The file is only
// ever read client-side into this field's text value — never uploaded as a
// file, and nothing about it is retained once read (the <input> is cleared
// immediately after, and the File object itself is dropped once the read
// resolves). Extension and size are checked before reading, and the decoded
// result is rejected if it looks binary, so a wrong file can't silently
// submit garbage into what the server treats as plain export text.
export function FileOrTextArea({ name, required, rows, placeholder, accept, fileHint, className }: FileOrTextAreaProps) {
  const [value, setValue] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const allowedExts = accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  async function loadFile(file: File) {
    setFileError(null);
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
    if (!allowedExts.includes(ext)) {
      setFileError(`Only ${fileHint} file is accepted.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError("That file is too large — expected a small text export.");
      return;
    }
    const text = await file.text();
    if (text.includes(String.fromCharCode(0))) {
      setFileError("That doesn't look like a text file.");
      return;
    }
    setValue(text);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        name={name}
        required={required}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void loadFile(file);
        }}
        className={`${className} ${dragOver ? "border-emerald-500" : ""}`}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded border border-neutral-700 px-2 py-1 font-medium text-neutral-300 transition-colors hover:border-neutral-500"
        >
          Choose file…
        </button>
        <span>or drag {fileHint} file onto the box above</span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {fileError && <p className="text-xs text-red-400">{fileError}</p>}
    </div>
  );
}

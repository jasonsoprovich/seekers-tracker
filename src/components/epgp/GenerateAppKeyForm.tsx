"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { generateAppKey } from "@/app/(app)/epgp/app-key/actions";
import { Button } from "@/components/ui/Button";
import { Field, fieldClasses } from "@/components/ui/Field";

export function GenerateAppKeyForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await generateAppKey(name);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNewKey(result.key ?? null);
    setName("");
    router.refresh();
  }

  if (newKey) {
    return (
      <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4">
        <p className="text-sm text-emerald-300">
          Key generated — copy it now and paste it into the EPGP parser app&apos;s Settings. You won&apos;t be able to see it again.
        </p>
        <code className="mt-2 block break-all rounded-md bg-black/40 px-3 py-2 font-mono text-sm text-neutral-100">{newKey}</code>
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(newKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setNewKey(null)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <Field className="w-56">
        <span className="text-neutral-400">Key name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Officer laptop"
          required
          className={fieldClasses({ size: "sm" })}
        />
      </Field>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Generating…" : "+ Generate app key"}
      </Button>
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </form>
  );
}

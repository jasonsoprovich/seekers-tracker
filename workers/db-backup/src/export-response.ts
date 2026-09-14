type ApiMessage = { code?: number; message?: string };

type ExportOperation = {
  at_bookmark?: string;
  error?: string;
  messages?: string[];
  result?: { filename?: string; signed_url?: string };
  status?: "complete" | "error";
  success?: boolean;
};

type ExportEnvelope = {
  errors?: ApiMessage[];
  result?: ExportOperation;
  success?: boolean;
};

export type CompletedExport = { filename: string; signedUrl: string };

function envelope(status: number, value: unknown): ExportEnvelope {
  const payload = value && typeof value === "object" ? (value as ExportEnvelope) : {};
  if (status < 200 || status >= 300 || payload.success !== true) {
    const details = payload.errors?.map((entry) => entry.message).filter(Boolean).join("; ");
    throw new Error(`D1 export API failed (${status})${details ? `: ${details}` : ""}`);
  }
  if (!payload.result) throw new Error("D1 export API returned no operation result");
  if (payload.result.status === "error" || payload.result.success === false) {
    throw new Error(`D1 export failed${payload.result.error ? `: ${payload.result.error}` : ""}`);
  }
  return payload;
}

export function parseExportStart(status: number, value: unknown): string {
  const operation = envelope(status, value).result!;
  if (!operation.at_bookmark) throw new Error("D1 export didn't return at_bookmark");
  return operation.at_bookmark;
}

export function parseExportPoll(status: number, value: unknown): CompletedExport | null {
  const operation = envelope(status, value).result!;
  if (operation.status !== "complete") return null;
  const signedUrl = operation.result?.signed_url;
  const filename = operation.result?.filename;
  if (!signedUrl || !filename) throw new Error("Completed D1 export did not include its download result");
  return { filename, signedUrl };
}

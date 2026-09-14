import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { parseExportPoll, parseExportStart } from "./export-response";

type Env = {
  BACKUP_WORKFLOW: Workflow;
  BACKUP_BUCKET: R2Bucket;
  D1_REST_API_TOKEN: string;
  ACCOUNT_ID: string;
  DATABASE_ID: string;
  KEEP_COUNT: string;
};

const BACKUP_PREFIX = "seekers-of-souls/";

async function listAllBackups(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

// D1's export API is async: POST once to start it (get back a bookmark),
// then POST again with that bookmark to poll — result.signed_url only
// appears once the dump is ready. There's no D1 binding method for this;
// it's only exposed over the regular Cloudflare REST API, hence the
// bearer token (D1:Edit scope) instead of just the D1 binding other
// Workers in this project use.
export class BackupWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const exportURL = `https://api.cloudflare.com/client/v4/accounts/${this.env.ACCOUNT_ID}/d1/database/${this.env.DATABASE_ID}/export`;
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.env.D1_REST_API_TOKEN}`,
    });

    // Throwing inside step.do() is the intended way to retry here — the
    // Workflow engine backs off and retries automatically, which is
    // exactly the polling behavior a not-yet-ready export needs.
    const bookmark = await step.do("start export", async () => {
      const res = await fetch(exportURL, { method: "POST", headers, body: JSON.stringify({ output_format: "polling" }) });
      return parseExportStart(res.status, await res.json());
    });

    const key = await step.do("poll until ready, store in R2", async () => {
      const res = await fetch(exportURL, {
        method: "POST",
        headers,
        body: JSON.stringify({ output_format: "polling", current_bookmark: bookmark }),
      });
      const result = parseExportPoll(res.status, await res.json());
      if (!result) throw new Error("D1 export not ready yet");

      const dump = await fetch(result.signedUrl);
      if (!dump.ok || !dump.body) throw new Error(`Couldn't fetch the export dump: ${dump.status}`);

      const timestamp = new Date().toISOString().replaceAll(":", "-");
      const filename = result.filename.split(/[\\/]/).pop() || "export.sql";
      const objectKey = `${BACKUP_PREFIX}${timestamp}-${event.instanceId}-${filename}`;
      await this.env.BACKUP_BUCKET.put(objectKey, dump.body);
      return objectKey;
    });

    // Count-based retention (not age-based): "keep the last N nightly
    // backups" is what was asked for, so a guild that goes quiet for a
    // week doesn't lose its whole backup history to an age cutoff.
    await step.do("prune old backups", async () => {
      const keepCount = Number(this.env.KEEP_COUNT) || 7;
      const newestFirst = (await listAllBackups(this.env.BACKUP_BUCKET)).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
      const stale = newestFirst.slice(keepCount);
      for (const obj of stale) {
        await this.env.BACKUP_BUCKET.delete(obj.key);
      }
    });

    return key;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("seekers-tracker-db-backup — nightly D1 -> R2 export, see wrangler.jsonc for the schedule. Not a public app.", {
      status: 200,
    });
  },
};

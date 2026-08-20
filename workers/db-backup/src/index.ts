import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Env = {
  BACKUP_WORKFLOW: Workflow;
  BACKUP_BUCKET: R2Bucket;
  D1_REST_API_TOKEN: string;
  ACCOUNT_ID: string;
  DATABASE_ID: string;
  KEEP_COUNT: string;
};

type ExportPollResult = {
  result?: { at_bookmark?: string; signed_url?: string; filename?: string };
};

const BACKUP_PREFIX = "seekers-of-souls/";

// D1's export API is async: POST once to start it (get back a bookmark),
// then POST again with that bookmark to poll — result.signed_url only
// appears once the dump is ready. There's no D1 binding method for this;
// it's only exposed over the regular Cloudflare REST API, hence the
// bearer token (D1:Edit scope) instead of just the D1 binding other
// Workers in this project use.
export class BackupWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
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
      const { result } = (await res.json()) as ExportPollResult;
      if (!result?.at_bookmark) throw new Error("D1 export didn't return at_bookmark");
      return result.at_bookmark;
    });

    const key = await step.do("poll until ready, store in R2", async () => {
      const res = await fetch(exportURL, { method: "POST", headers, body: JSON.stringify({ current_bookmark: bookmark }) });
      const { result } = (await res.json()) as ExportPollResult;
      if (!result?.signed_url || !result.filename) throw new Error("D1 export not ready yet");

      const dump = await fetch(result.signed_url);
      if (!dump.ok || !dump.body) throw new Error(`Couldn't fetch the export dump: ${dump.status}`);

      const objectKey = `${BACKUP_PREFIX}${new Date().toISOString().slice(0, 10)}-${result.filename}`;
      await this.env.BACKUP_BUCKET.put(objectKey, dump.body);
      return objectKey;
    });

    // Count-based retention (not age-based): "keep the last N nightly
    // backups" is what was asked for, so a guild that goes quiet for a
    // week doesn't lose its whole backup history to an age cutoff.
    await step.do("prune old backups", async () => {
      const keepCount = Number(this.env.KEEP_COUNT) || 7;
      const listed = await this.env.BACKUP_BUCKET.list({ prefix: BACKUP_PREFIX });
      const newestFirst = listed.objects.slice().sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
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

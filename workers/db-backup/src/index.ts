import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { parseExportPoll, parseExportStart } from "./export-response";

type Env = {
  BACKUP_WORKFLOW: Workflow;
  BACKUP_BUCKET: R2Bucket;
  OPS_METADATA: R2Bucket;
  D1_REST_API_TOKEN: string;
  ACCOUNT_ID: string;
  DATABASE_ID: string;
  KEEP_COUNT: string;
};

const BACKUP_PREFIX = "seekers-of-souls/";
const BACKUP_STATUS_KEY = "system-health/backup.json";

type BackupStatus = {
  schemaVersion: 1;
  latestAttempt: { status: "running" | "succeeded" | "failed"; instanceId: string; startedAt: string; completedAt?: string; failedAt?: string; error?: string };
  lastSuccess?: { completedAt: string; objectKey: string; objectSize: number; bookmark: string; retainedObjects: number };
};

async function readBackupStatus(bucket: R2Bucket): Promise<BackupStatus | null> {
  try {
    const object = await bucket.get(BACKUP_STATUS_KEY);
    return object ? ((await object.json()) as BackupStatus) : null;
  } catch {
    return null;
  }
}

async function writeBackupStatus(bucket: R2Bucket, status: BackupStatus): Promise<void> {
  await bucket.put(BACKUP_STATUS_KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
}

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

    const startedAt = new Date().toISOString();
    const previous = await step.do("record backup start", async () => {
      const prior = await readBackupStatus(this.env.OPS_METADATA);
      await writeBackupStatus(this.env.OPS_METADATA, {
        schemaVersion: 1,
        latestAttempt: { status: "running", instanceId: event.instanceId, startedAt },
        ...(prior?.lastSuccess ? { lastSuccess: prior.lastSuccess } : {}),
      });
      return prior;
    });

    try {
      // Throwing inside step.do() is the intended way to retry here — the
      // Workflow engine backs off and retries automatically, which is
      // exactly the polling behavior a not-yet-ready export needs.
      const bookmark = await step.do("start export", async () => {
        const res = await fetch(exportURL, { method: "POST", headers, body: JSON.stringify({ output_format: "polling" }) });
        return parseExportStart(res.status, await res.json());
      });

      const backup = await step.do("poll until ready, store in R2", async () => {
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
        const object = await this.env.BACKUP_BUCKET.put(objectKey, dump.body, { customMetadata: { bookmark, workflowInstanceId: event.instanceId } });
        return { key: objectKey, size: object.size };
      });

      // Count-based retention keeps the newest N successful exports even if
      // a scheduled day is missed.
      const retainedObjects = await step.do("prune old backups", async () => {
        const keepCount = Number(this.env.KEEP_COUNT) || 35;
        const newestFirst = (await listAllBackups(this.env.BACKUP_BUCKET)).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
        for (const obj of newestFirst.slice(keepCount)) await this.env.BACKUP_BUCKET.delete(obj.key);
        return Math.min(newestFirst.length, keepCount);
      });

      const completedAt = new Date().toISOString();
      await step.do("record backup success", async () => {
        const success = { completedAt, objectKey: backup.key, objectSize: backup.size, bookmark, retainedObjects };
        await writeBackupStatus(this.env.OPS_METADATA, {
          schemaVersion: 1,
          latestAttempt: { status: "succeeded", instanceId: event.instanceId, startedAt, completedAt },
          lastSuccess: success,
        });
      });

      return backup.key;
    } catch (error) {
      try {
        await step.do("record backup failure", async () => {
          await writeBackupStatus(this.env.OPS_METADATA, {
            schemaVersion: 1,
            latestAttempt: {
              status: "failed",
              instanceId: event.instanceId,
              startedAt,
              failedAt: new Date().toISOString(),
              error: String(error instanceof Error ? error.message : error).slice(0, 300),
            },
            ...(previous?.lastSuccess ? { lastSuccess: previous.lastSuccess } : {}),
          });
        });
      } catch (metadataError) {
        console.error(`Couldn't record backup failure metadata: ${metadataError}`);
      }
      throw error;
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("seekers-tracker-db-backup — daily D1 -> R2 export. Not a public app.", {
      status: 200,
    });
  },
};

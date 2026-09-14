// Phase 10.4: fixture checks for the current nested Cloudflare D1 export API.
import assert from "node:assert/strict";

import { parseExportPoll, parseExportStart } from "../workers/db-backup/src/export-response";

const bookmark = "00000001-00000002-00000003-00000004";

assert.equal(parseExportStart(200, { success: true, result: { at_bookmark: bookmark, success: true, type: "export" } }), bookmark);
assert.equal(parseExportPoll(200, { success: true, result: { at_bookmark: bookmark, success: true, type: "export" } }), null);
assert.deepEqual(
  parseExportPoll(200, {
    success: true,
    result: {
      at_bookmark: bookmark,
      status: "complete",
      success: true,
      type: "export",
      result: { filename: "dump.sql", signed_url: "https://example.invalid/dump.sql" },
    },
  }),
  { filename: "dump.sql", signedUrl: "https://example.invalid/dump.sql" },
);
assert.throws(() => parseExportPoll(200, { success: true, result: { status: "error", success: false, error: "export cancelled" } }), /export cancelled/);
assert.throws(() => parseExportStart(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }), /Authentication error/);
assert.throws(() => parseExportPoll(200, { success: true, result: { status: "complete", success: true } }), /download result/);

console.log("D1 export response checks passed.");

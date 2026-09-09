import { execSync } from "node:child_process";

import type { NextConfig } from "next";

// A stable, inspectable build id. Next otherwise generates a random one per
// build; pinning it to the commit SHA (a) makes `/_next/static/<id>/...` and
// the uploaded `/BUILD_ID` asset deterministic, and (b) lets us hand the same
// value to both the client bundle (via `env` below, inlined at build) and the
// running server (via `/api/health`), so a tab can tell when the deployed
// build has moved on under it — see src/components/system/VersionGuard.tsx.
// Falls back to a timestamp when git isn't available (shouldn't happen in a
// normal build, but never break the build over it).
function resolveBuildId(): string {
	if (process.env.NEXT_PUBLIC_BUILD_ID) return process.env.NEXT_PUBLIC_BUILD_ID;
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
	} catch {
		return String(Date.now());
	}
}

const buildId = resolveBuildId();

const nextConfig: NextConfig = {
	generateBuildId: () => buildId,
	// Inlined into both client and server bundles at build time.
	env: {
		NEXT_PUBLIC_BUILD_ID: buildId,
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

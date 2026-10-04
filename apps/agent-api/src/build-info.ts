import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

function runtimeFingerprint(): string {
  try {
    const hash = createHash("sha256");
    const directory = new URL(".", import.meta.url);
    const files = readdirSync(directory).filter((name) => name.endsWith(".js")).sort();
    if (!files.includes("server.js") || !files.includes("worker.js")) return "source";
    for (const name of files) {
      hash.update(name);
      hash.update(readFileSync(new URL(name, import.meta.url)));
    }
    return hash.digest("hex").slice(0, 16);
  } catch { return "source"; }
}
export const buildInfo = Object.freeze({
  version: process.env.NPATI_AGENT_VERSION ?? "0.1.0",
  commit: process.env.NPATI_BUILD_COMMIT ?? "unknown",
  builtAt: process.env.NPATI_BUILD_TIME ?? "unknown",
  fingerprint: runtimeFingerprint(),
});
export function logBuildInfo(service: string): void {
  console.info("[build-info] " + JSON.stringify({ service, ...buildInfo, startedAt: new Date().toISOString() }));
}

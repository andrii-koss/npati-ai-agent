import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { parsePreviewOrigin, previewOriginMeta } from "../apps/agent-api/src/preview-origin-config";
import { isIsolatedPreviewHost } from "../apps/agent-api/src/project-preview-cookies";
import { registerWebFrontend } from "../apps/agent-api/src/web-frontend";

const saved = process.env.NPATI_PREVIEW_ORIGIN;
afterEach(() => { if (saved === undefined) delete process.env.NPATI_PREVIEW_ORIGIN; else process.env.NPATI_PREVIEW_ORIGIN = saved; });

describe("Preview origin set by the installation (NPATI_PREVIEW_ORIGIN)", () => {
  it("accepts a scheme and host with {project} in the first label, and matches only those hosts", () => {
    const config = parsePreviewOrigin("https://{project}-preview.example.com/")!;
    expect(config.template).toBe("https://{project}-preview.example.com");
    expect(config.hostPattern.test("a25b241a-8bd2-preview.example.com")).toBe(true);
    expect(config.hostPattern.test("app.example.com")).toBe(false);
    expect(config.hostPattern.test("x-preview.example.com.evil.net")).toBe(false);
    expect(parsePreviewOrigin("http://{project}.preview.local:8080")!.hostPattern.test("p1.preview.local:8080")).toBe(true);
    expect(parsePreviewOrigin(undefined)).toBeNull();
    expect(parsePreviewOrigin("  ")).toBeNull();
  });

  it.each([
    "preview.example.com", "https://preview.example.com", "https://example.com/{project}", "https://{project}.{project}.example.com",
    "https://www.{project}.example.com", "ftp://{project}.example.com", "https://{project}.example.com/path", "https://user:pw@{project}.example.com",
  ])("refuses %s with a message that shows the expected form", value => {
    expect(() => parsePreviewOrigin(value)).toThrow(/NPATI_PREVIEW_ORIGIN/);
  });

  it("counts the configured hosts as isolated Preview hosts, beside the built-in <project>.preview.* form", () => {
    delete process.env.NPATI_PREVIEW_ORIGIN;
    expect(isIsolatedPreviewHost("p1.preview.localhost:13001")).toBe(true);
    expect(isIsolatedPreviewHost("p1-preview.example.com")).toBe(false);
    process.env.NPATI_PREVIEW_ORIGIN = "https://{project}-preview.example.com";
    expect(isIsolatedPreviewHost("p1-preview.example.com")).toBe(true);
    expect(isIsolatedPreviewHost("app.example.com")).toBe(false);
  });

  it("hands the origin to the web app in index.html, escaped, and adds nothing when unset", async () => {
    expect(previewOriginMeta(parsePreviewOrigin("https://{project}.preview.example.com"))).toBe('<meta name="npati-preview-origin" content="https://{project}.preview.example.com">');
    const dir = mkdtempSync(path.join(tmpdir(), "npati-web-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>x</title></head><body></body></html>");
    for (const value of ["https://{project}.preview.example.com", undefined]) {
      if (value) process.env.NPATI_PREVIEW_ORIGIN = value; else delete process.env.NPATI_PREVIEW_ORIGIN;
      const app = Fastify(); registerWebFrontend(app, dir); await app.ready();
      const page = await app.inject({ method: "GET", url: "/chat", headers: { accept: "text/html" } });
      if (value) expect(page.body).toContain('<meta name="npati-preview-origin" content="https://{project}.preview.example.com">\n</head>');
      else expect(page.body).not.toContain("npati-preview-origin");
      await app.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { previewBrowserBridge, rewritePreviewSsrResources } from "../apps/agent-api/src/preview-browser-bridge";

describe("hydrated preview resource URLs", () => {
  it("routes React link attributes and webpack link properties through the signed project proxy", () => {
    class Script { attributes: Record<string,string> = {}; get src() {return this.attributes.src;} set src(value: string) {this.attributes.src=value;} setAttribute(name: string, value: string) { this.attributes[name] = value; } }
    class Link extends Script { get href() { return this.attributes.href; } set href(value: string) { this.attributes.href = value; } }
    const prefix = "/api/companies/c/projects/p/preview/proxy";
    const location = { href: "http://preview.test" + prefix + "/", origin: "http://preview.test" };
    const script = previewBrowserBridge(prefix, "signed").replace(/^<script>|<\/script>$/g, "");
    runInNewContext(script, { URL, Request, location, HTMLScriptElement: Script, HTMLLinkElement: Link, document: { addEventListener() {} }, window: { fetch() {} }, history: { pushState() {}, replaceState() {} } });
    const trustedURL = {toString: () => "/_next/static/chunks/lazy.js"} as unknown as string;
    const modulePreload = new Link(); modulePreload.href="/_nuxt/runtime.js?token=signed";
    const moduleScript = new Script(); moduleScript.src="/_nuxt/runtime.js";
    expect(modulePreload.href).toBe(moduleScript.src);
    const relativeImport = new URL("./runtime.js",location.origin+prefix+"/_nuxt/page.js").href;
    expect(moduleScript.src).toBe(relativeImport);
    const chunk = new Script(); chunk.src=trustedURL;
    expect(chunk.src).toBe(location.origin+prefix+"/_next/static/chunks/lazy.js");
    chunk.setAttribute("src",trustedURL);expect(chunk.attributes.src).toContain(prefix+"/_next/static/chunks/lazy.js");
    const stylesheet = new Link(); stylesheet.setAttribute("href", "/_next/static/css/layout.css");
    expect(stylesheet.attributes.href).toBe(location.origin + prefix + "/_next/static/css/layout.css");
    const preload = new Link(); preload.setAttribute("HREF", "/_next/static/chunks/app/layout.js");
    expect(preload.attributes.HREF).toBe(location.origin + prefix + "/_next/static/chunks/app/layout.js");
    stylesheet.href = "/_next/static/css/lazy.css";
    expect(stylesheet.href).toContain(prefix + "/_next/static/css/lazy.css");
    stylesheet.setAttribute("rel", "stylesheet"); expect(stylesheet.attributes.rel).toBe("stylesheet");
    stylesheet.setAttribute("href", "https://cdn.test/external.css"); expect(stylesheet.attributes.href).toBe("https://cdn.test/external.css");
  });
});

describe("inline SSR module resources", () => {
  it("routes static/dynamic ESM imports and React Router asset manifests with one module identity", () => {
    const prefix = "/api/companies/c/projects/p/preview/proxy";
    const html = '<script type="module">import * as root from "/assets/root.js";window.__reactRouterManifest={entry:{module:"/assets/entry.js",imports:["/assets/shared.mjs"],css:["/assets/root.css"]}};import("/assets/entry.js");</script>';
    const rewritten = rewritePreviewSsrResources(html, prefix);
    for (const asset of ["root.js", "entry.js", "shared.mjs", "root.css"]) expect(rewritten).toContain(prefix + "/assets/" + asset);
    expect(rewritePreviewSsrResources(rewritten, prefix)).toBe(rewritten);
    expect(rewritten).not.toContain("token=");
  });
  it("preserves other projects, external imports, relative imports, routes, and nonmodule data", () => {
    const prefix = "/api/companies/c/projects/p/preview/proxy";
    const html = '<script type="application/json">{"file":"/assets/data.js"}</script><script>const path="/assets/not-module.js"</script><script type=module>import "https://cdn.test/a.js";import "//cdn.test/a.js";import "./relative.js";const route="/health";const scoped="/api/companies/c/projects/other/preview/proxy/assets/file.js";</script>';
    expect(rewritePreviewSsrResources(html, prefix)).toBe(html);
    const other = rewritePreviewSsrResources('<script type="module">import "/assets/root.js"</script>', prefix.replace("/p/", "/other/"));
    expect(other).toContain("/projects/other/preview/proxy/assets/root.js");
    expect(other).not.toContain(prefix + "/");
  });
});

it("navigates project API links through Preview without rerouting SDK platform fetches", () => {
  const prefix = "/api/companies/c/projects/p/preview/proxy";
  let click: (event: unknown) => void = () => {};
  let assigned = "";
  class Element { closest() { return this; } getAttribute() { return "/api/info"; } hasAttribute() { return false; } target = ""; }
  const location = { href: "http://preview.test" + prefix + "/", origin: "http://preview.test", assign: (url: string) => { assigned = url; } };
  const window = { fetch: (url: string) => url };
  const script = previewBrowserBridge(prefix, "signed").replace(/^<script>|<\/script>$/g, "");
  runInNewContext(script, { URL, Request, location, Element, window, document: { addEventListener: (_name: string, handler: typeof click) => { click = handler; } }, history: { pushState() {}, replaceState() {} } });
  expect(window.fetch("/api/companies/c/projects/p")).toBe("/api/companies/c/projects/p");
  click({ target: new Element(), button: 0, preventDefault() {}, stopImmediatePropagation() {} });
  expect(new URL(assigned).pathname).toBe(prefix + "/api/info");
});

it.each(["/", "/shop"])("hydrates React Router at its scoped basename %s without changing route data", (basename) => {
  const prefix = "/api/companies/c/projects/p/preview/proxy";
  const context = { basename, ssr: true, future: {}, hydrationData: { label: "</script>" } };
  const source = '<script>window.__reactRouterContext=' + JSON.stringify(context).replace(/</g,"\\u003c") + ';window.next=1;</script>';
  const rewritten = rewritePreviewSsrResources(source, prefix);
  const window: Record<string, unknown> = {};
  runInNewContext(rewritten.replace(/^<script>|<\/script>$/g,""), { window });
  expect(window.__reactRouterContext).toEqual({ ...context, basename: prefix + (basename === "/" ? "" : basename) });
  expect(window.next).toBe(1);
  expect(rewritePreviewSsrResources(rewritten, prefix)).toBe(rewritten);
  expect(rewritten).not.toContain('"</script>"');
});

it("sends the app's own /api requests to its backend, and platform calls of this project to the platform", () => {
  const prefix = "/api/companies/c/projects/p/preview/proxy";
  const location = { href: "http://preview.test" + prefix + "/", origin: "http://preview.test", assign() {} };
  const window = { fetch: (url: string) => url };
  const script = previewBrowserBridge(prefix, "signed").replace(/^<script>|<\/script>$/g, "");
  runInNewContext(script, { URL, Request, location, Element: class {}, window, document: { addEventListener() {} }, history: { pushState() {}, replaceState() {} } });
  expect(new URL(window.fetch("/api/auth/register")).pathname).toBe(prefix + "/api/auth/register");
  expect(new URL(window.fetch("/api/companies")).pathname).toBe(prefix + "/api/companies");
  expect(window.fetch("/api/companies/c/projects/p/data")).toBe("/api/companies/c/projects/p/data");
});

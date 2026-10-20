import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { previewBrowserBridge } from "../apps/agent-api/src/preview-browser-bridge";

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

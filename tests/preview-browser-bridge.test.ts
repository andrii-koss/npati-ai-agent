import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";
import { previewBrowserBridge } from "../apps/agent-api/src/preview-browser-bridge";

function browser() {
  const prefix = "/api/companies/c/projects/p/preview/proxy";
  let click: (event: any) => void;
  class Anchor {
    target = "";
    constructor(public href: string) {}
    closest() { return this; }
    getAttribute() { return this.href; }
    hasAttribute() { return false; }
  }
  const assign = vi.fn(), fetch = vi.fn(), pushState = vi.fn();
  const context = { URL, Request, Element: Anchor,
    location: { href: "http://localhost:3000"+prefix+"/?token=signed", origin: "http://localhost:3000", assign },
    document: { addEventListener: (_name: string, handler: typeof click) => { click = handler; } },
    history: { pushState, replaceState: vi.fn() },
    window: { fetch, open: vi.fn() },
  };
  const code = previewBrowserBridge(prefix, "signed").slice("<script>".length, -"</script>".length);
  vm.runInNewContext(code, context);
  const navigate = (href: string) => {
    const event = { target: new Anchor(href), button: 0, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    click(event); return event;
  };
  return { context, navigate, assign, fetch, pushState, prefix };
}

describe("hydrated project Preview routing", () => {
  it("keeps React-restored auth and catalog links in the selected project", () => {
    const b = browser();
    expect(b.navigate("/auth").preventDefault).toHaveBeenCalled();
    expect(b.assign).toHaveBeenLastCalledWith("http://localhost:3000"+b.prefix+"/auth?token=signed");
    b.navigate("/");
    expect(b.assign).toHaveBeenLastCalledWith("http://localhost:3000"+b.prefix+"/?token=signed");
  });
  it("routes client fetch/history but never signs external URLs or platform API requests", () => {
    const b = browser();
    b.context.window.fetch("/shop?_rsc=abc");
    expect(b.fetch).toHaveBeenLastCalledWith("http://localhost:3000"+b.prefix+"/shop?_rsc=abc&token=signed", undefined);
    b.context.history.pushState({}, "", "/shop");
    expect(b.pushState).toHaveBeenLastCalledWith({}, "", "http://localhost:3000"+b.prefix+"/shop?token=signed");
    for (const url of ["https://external.example/auth", "/api/v1/projects/p/products", "http://localhost:3000/v1/projects/p/data/products"]) {
      expect(b.navigate(url).preventDefault).not.toHaveBeenCalled();
      b.context.window.fetch(url);
      expect(b.fetch).toHaveBeenLastCalledWith(url, undefined);
    }
    expect(b.navigate("#cart").preventDefault).not.toHaveBeenCalled();
  });
});

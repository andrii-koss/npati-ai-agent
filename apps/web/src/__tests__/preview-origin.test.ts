// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isolatedPreviewUrl } from "../preview-origin";

const proxy = "/api/companies/c1/projects/A25B241A-8bd2/preview/proxy/index.html";
afterEach(() => { document.head.querySelectorAll('meta[name="npati-preview-origin"]').forEach(meta => meta.remove()); });

describe("Preview origin", () => {
  it("uses the origin the server put in index.html, with the project id as the host name", () => {
    const meta = document.createElement("meta"); meta.name = "npati-preview-origin"; meta.content = "https://{project}.preview.example.com";
    document.head.append(meta);
    expect(isolatedPreviewUrl(proxy)).toBe("https://a25b241a-8bd2.preview.example.com" + proxy);
  });

  it("falls back to <project>.preview.localhost on a local installation, and leaves other URLs alone", () => {
    expect(isolatedPreviewUrl(proxy)).toBe(`${location.protocol}//a25b241a-8bd2.preview.localhost${location.port ? ":" + location.port : ""}${proxy}`);
    expect(isolatedPreviewUrl("/settings")).toBe("/settings");
    expect(isolatedPreviewUrl(undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  BrowserDomSnapshotEngine,
  BrowserScreenshotEngine,
  BrowserPdfCaptureEngine,
} from "../apps/agent-api/src/browser-visual-and-dom-capture";

describe("Browser DOM Snapshot Engine (BrowserDomSnapshotEngine)", () => {
  it("strips scripts and extracts interactive element nodes", () => {
    const rawHtml = `
      <html>
        <head>
          <script>console.log("secret tracker");</script>
          <style>.btn { color: red; }</style>
        </head>
        <body>
          <h1>Welcome to NPATI AI</h1>
          <input id="email-field" type="email" placeholder="Enter email" />
          <button id="login-button">Sign In</button>
          <a href="/pricing">View Plans</a>
        </body>
      </html>
    `;

    const snapshot = BrowserDomSnapshotEngine.captureSnapshot(rawHtml);

    expect(snapshot.cleanTree).not.toContain("secret tracker");
    expect(snapshot.cleanTree).not.toContain("color: red");
    expect(snapshot.interactiveCount).toBe(3);
    expect(snapshot.interactiveNodes.some((n) => n.id === "email-field")).toBe(true);
    expect(snapshot.interactiveNodes.some((n) => n.id === "login-button")).toBe(true);
    expect(snapshot.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("Browser Screenshot Engine (BrowserScreenshotEngine)", () => {
  it("captures full-page and viewport screenshots", () => {
    const viewportShot = BrowserScreenshotEngine.capture("tab-123", { fullPage: false });
    expect(viewportShot.dimensions.height).toBe(800);
    expect(viewportShot.mimeType).toBe("image/png");
    expect(viewportShot.base64Data.length).toBeGreaterThan(0);

    const fullPageShot = BrowserScreenshotEngine.capture("tab-123", { fullPage: true, format: "jpeg" });
    expect(fullPageShot.dimensions.height).toBe(2400);
    expect(fullPageShot.mimeType).toBe("image/jpeg");
  });
});

describe("Browser PDF Capture Engine (BrowserPdfCaptureEngine)", () => {
  it("generates structured PDF captures of web documents", () => {
    const pdfRes = BrowserPdfCaptureEngine.capturePdf("tab-456", { landscape: true });

    expect(pdfRes.pdfId).toMatch(/^pdf_/);
    expect(pdfRes.pageCount).toBe(2);
    expect(pdfRes.fileSizeBytes).toBeGreaterThan(0);
    expect(pdfRes.pdfBase64.length).toBeGreaterThan(0);
  });
});

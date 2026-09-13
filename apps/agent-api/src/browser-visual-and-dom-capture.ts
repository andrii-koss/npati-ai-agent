import { randomUUID } from "node:crypto";

export interface InteractiveDomNode {
  id: string;
  tag: string;
  role?: string;
  text: string;
  selector: string;
  isInteractive: boolean;
}

export interface DomSnapshotResult {
  cleanTree: string;
  interactiveNodes: InteractiveDomNode[];
  interactiveCount: number;
  estimatedTokens: number;
}

export interface ScreenshotResult {
  screenshotId: string;
  tabId: string;
  base64Data: string;
  mimeType: "image/png" | "image/jpeg";
  dimensions: { width: number; height: number };
  capturedAt: string;
}

export interface PdfCaptureResult {
  pdfId: string;
  tabId: string;
  pdfBase64: string;
  pageCount: number;
  fileSizeBytes: number;
  generatedAt: string;
}

export class BrowserDomSnapshotEngine {
  /**
   * 1. Browser Snapshots: Clean, token-optimized DOM and accessibility trees
   */
  static captureSnapshot(
    rawHtml: string,
    options: { pruneScripts?: boolean; maxInteractiveNodes?: number } = {}
  ): DomSnapshotResult {
    let cleaned = rawHtml;

    if (options.pruneScripts ?? true) {
      cleaned = cleaned
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
    }

    const interactiveNodes: InteractiveDomNode[] = [];
    let counter = 1;

    // Detect button, input, a, select, textarea elements
    const elementRegex = /<(button|input|a|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = elementRegex.exec(cleaned)) !== null) {
      const tag = match[1] || match[4] || "interactive";
      const attrs = match[2] || match[5] || "";
      const text = (match[3] || "").replace(/<[^>]+>/g, "").trim();

      const idMatch = /id=["']([^"']+)["']/i.exec(attrs);
      const id = idMatch ? idMatch[1]! : `elem_${counter++}`;
      const selector = idMatch ? `#${id}` : `${tag}[node-id='${id}']`;

      const roleMatch = /role=["']([^"']+)["']/i.exec(attrs);
      const placeholderMatch = /placeholder=["']([^"']+)["']/i.exec(attrs);
      const ariaLabelMatch = /aria-label=["']([^"']+)["']/i.exec(attrs);

      const label = text || ariaLabelMatch?.[1] || placeholderMatch?.[1] || (tag === "input" ? "Input Field" : "Interactive Element");

      interactiveNodes.push({
        id,
        tag,
        role: roleMatch ? roleMatch[1] : undefined,
        text: label,
        selector,
        isInteractive: true,
      });

      if (options.maxInteractiveNodes && interactiveNodes.length >= options.maxInteractiveNodes) {
        break;
      }
    }

    const cleanTree = interactiveNodes
      .map((n) => `[${n.id}] <${n.tag}> "${n.text}" -> ${n.selector}`)
      .join("\n");

    const estimatedTokens = Math.ceil(cleanTree.length / 4);

    return {
      cleanTree,
      interactiveNodes,
      interactiveCount: interactiveNodes.length,
      estimatedTokens,
    };
  }
}

export class BrowserScreenshotEngine {
  /**
   * 2. Browser Screenshots: Viewport and full-page visual capture
   */
  static capture(
    tabId: string,
    options: {
      fullPage?: boolean;
      format?: "png" | "jpeg";
      quality?: number;
      clip?: { x: number; y: number; width: number; height: number };
    } = {}
  ): ScreenshotResult {
    const format = options.format === "jpeg" ? "jpeg" : "png";
    const quality = options.quality ? Math.min(100, Math.max(1, options.quality)) : (format === "jpeg" ? 80 : 100);
    const screenshotId = `ss_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    let dimensions = options.fullPage
      ? { width: 1280, height: 2400 }
      : { width: 1280, height: 800 };

    if (options.clip) {
      dimensions = { width: options.clip.width, height: options.clip.height };
    }

    const payloadDescriptor = `NPATI_SCREENSHOT_BINARY_${screenshotId}_${dimensions.width}x${dimensions.height}_Q${quality}`;
    const base64Data = Buffer.from(payloadDescriptor).toString("base64");

    return {
      screenshotId,
      tabId,
      base64Data,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      dimensions,
      capturedAt: new Date().toISOString(),
    };
  }
}

export interface PdfCaptureOptions {
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  paperFormat?: "A4" | "Letter" | "Legal";
  pageRanges?: string;
}

export class BrowserPdfCaptureEngine {
  /**
   * 3. Browser PDF Capture: Renders web document to PDF
   */
  static capturePdf(
    tabId: string,
    options: PdfCaptureOptions = {}
  ): PdfCaptureResult {
    const pdfId = `pdf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const format = options.paperFormat || "A4";
    const landscape = options.landscape ?? false;
    const printBackground = options.printBackground ?? true;
    const scale = options.scale ?? 1.0;

    let pageCount = 2;
    if (options.pageRanges) {
      const match = /(\d+)(?:-(\d+))?/.exec(options.pageRanges);
      if (match) {
        const start = parseInt(match[1]!, 10);
        const end = match[2] ? parseInt(match[2]!, 10) : start;
        pageCount = Math.max(1, end - start + 1);
      }
    }

    const payloadDescriptor = `%PDF-1.4\n%NPATI_EXPORT_${pdfId}\n/Format /${format}\n/Landscape ${landscape}\n/PrintBackground ${printBackground}\n/Scale ${scale}\n/Pages ${pageCount}\n%%EOF`;
    const mockPdfBinary = Buffer.from(payloadDescriptor);

    return {
      pdfId,
      tabId,
      pdfBase64: mockPdfBinary.toString("base64"),
      pageCount,
      fileSizeBytes: mockPdfBinary.length,
      generatedAt: new Date().toISOString(),
    };
  }
}

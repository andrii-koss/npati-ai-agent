export interface BrowserDiagnostic {
  type: "pageerror" | "error";
  cause: string;
  message: string;
  source: string;
  /** The error class, e.g. TypeError; never the page-controlled message. */
  errorName?: string;
  line?: number;
  column?: number;
}
export function normalizeBrowserDiagnostic(value: unknown): BrowserDiagnostic;
export function isBlockedExternalResource(text: unknown, location: { url?: string } | undefined, origin: string): boolean;
export function captureBrowserDiagnostic(type: string, message: unknown, location: unknown, stack: unknown, origin: string): BrowserDiagnostic;

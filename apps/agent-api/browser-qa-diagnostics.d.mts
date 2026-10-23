export interface BrowserDiagnostic {
  type: "pageerror" | "error";
  cause: string;
  message: string;
  source: string;
  line?: number;
  column?: number;
}
export function normalizeBrowserDiagnostic(value: unknown): BrowserDiagnostic;
export function captureBrowserDiagnostic(type: string, message: unknown, location: unknown, stack: unknown, origin: string): BrowserDiagnostic;

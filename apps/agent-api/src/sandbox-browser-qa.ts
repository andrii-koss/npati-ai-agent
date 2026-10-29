import { normalizeBrowserDiagnostic } from "../browser-qa-diagnostics.mjs";
import { assertBrowserQaActions } from "../browser-qa-actions.mjs";
import { SandboxProviderError, type SandboxBrowserQaOptions, type SandboxBrowserQaResult } from "./sandbox-provider";

export function assertBrowserQaOptions(options: SandboxBrowserQaOptions): void {
  try { assertBrowserQaActions(options.actions); } catch { throw new SandboxProviderError("invalid_qa_options", "Invalid browser actions", 400, "browser_qa", "project.qa.inspect"); }
  if (options?.screenshotMode !== undefined && !["layout", "visual"].includes(options.screenshotMode)) throw new SandboxProviderError("invalid_qa_options", "Invalid screenshot mode", 400, "browser_qa", "project.qa.inspect");
  if (!options || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      typeof options.path !== "string" || !/^\/(?!\/)[A-Za-z0-9/_~.%-]*$/.test(options.path) || options.path.includes("..") || options.path.length > 512 ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000 ||
      !Number.isInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes < 50000 || options.maxScreenshotBytes > 2000000 ||
      !Number.isInteger(options.maxBrokenLinks) || options.maxBrokenLinks < 1 || options.maxBrokenLinks > 50 ||
      !Number.isInteger(options.viewport?.width) || options.viewport.width < 320 || options.viewport.width > 1920 ||
      !Number.isInteger(options.viewport?.height) || options.viewport.height < 320 || options.viewport.height > 1200) {
    throw new SandboxProviderError("invalid_qa_options", "Invalid browser QA options", 400, "browser_qa", "project.qa.inspect");
  }
}

export function parseBrowserQaResult(stdout: string): SandboxBrowserQaResult {
  try {
    const result = JSON.parse(stdout) as SandboxBrowserQaResult;
    if (!result || !Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599 ||
        !Array.isArray(result.brokenLinks) || result.brokenLinks.length > 50 ||
        !Array.isArray(result.accessibility) || result.accessibility.length > 100 ||
        !Number.isInteger(result.consoleErrorCount) || result.consoleErrorCount < 0 || result.consoleErrorCount > 100 ||
        ![result.loadTimeMs, result.domContentLoadedMs, result.resourceCount, result.totalSizeBytes].every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("invalid_browser_result");
    }
    if (Array.isArray(result.consoleDiagnostics)) result.consoleDiagnostics =
      result.consoleDiagnostics.slice(0, Math.min(5, result.consoleErrorCount)).map(normalizeBrowserDiagnostic);
    else delete result.consoleDiagnostics;
    if(result.interactionTrace!==undefined){
      if(!Array.isArray(result.interactionTrace)||result.interactionTrace.length>16)throw new Error("invalid_interaction_trace");
      assertBrowserQaActions(result.interactionTrace.map(step=>step.action));
      for(const step of result.interactionTrace){
        if(!["completed","failed"].includes(step.status))throw new Error("invalid_interaction_trace");
        for(const view of [step.before,step.after])if(!view||typeof view.text!=="string"||view.text.length>1400||!Array.isArray(view.buttons)||view.buttons.length>32
          ||view.buttons.some(button=>typeof button.label!=="string"||button.label.length>100||typeof button.disabled!=="boolean")
          ||view.canvasHash!==undefined&&!/^[a-f0-9]{1,8}$/.test(view.canvasHash))throw new Error("invalid_interaction_trace");
      }
    }
    return result;
  } catch {
    throw new SandboxProviderError("qa_invalid_result", "Browser QA runner returned invalid output", 503, "browser_qa", "project.qa.inspect");
  }
}

export function browserQaFailure(stdout: string): SandboxProviderError {
  let stage: string | undefined;
  try {
    const value = JSON.parse(stdout);
    if (["input", "launch", "navigation", "inspection", "links", "screenshot"].includes(value?.stage)) stage = value.stage;
  } catch { /* Never include raw browser output in diagnostics. */ }
  return new SandboxProviderError("qa_failed", stage ? "Browser QA runner failed during " + stage : "Browser QA runner failed", 503, "browser_qa", "project.qa.inspect");
}

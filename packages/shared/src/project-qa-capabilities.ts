import type { CapabilityDefinition } from "./capabilities";
import type { CapabilityMatrixEntry } from "./capability-matrix";

export const PROJECT_QA_CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "project.qa.inspect",
    inventoryIds: [333],
    type: "tool",
    domain: "orchestration",
    name: "Project Browser QA Inspect",
    description: "Inspect website preview with headless browser, collecting screenshots, console errors, broken links, accessibility (a11y), and performance audits.",
    useWhen: ["An authorized QA or Developer agent needs to inspect, test, and audit the website preview in a browser."],
    doNotUseWhen: ["The project is archived or preview server is not accessible."],
    agentCallable: true,
    userVisible: true,
    risk: "medium",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: ["workspace:read"],
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string" },
        path: { type: "string", description: "Subpath to inspect, e.g. / or /about" },
        viewport: {
          type: "string",
          enum: ["desktop", "tablet", "mobile"],
          description: "Target screen viewport",
        },
        checks: {
          type: "array",
          items: { type: "string", enum: ["console", "links", "a11y", "performance", "screenshot"] },
          description: "Subset of checks to run (defaults to all)",
        },
        timeoutMs: { type: "number", description: "Timeout limit in milliseconds (max 60000)" },
        maxScreenshotBytes: { type: "number", description: "Maximum screenshot size in bytes (max 2000000)" },
      },
    },
    version: 1,
  },
  {
    id: "project.qa.report",
    inventoryIds: [334],
    type: "tool",
    domain: "orchestration",
    name: "Project Browser QA Report",
    description: "Retrieve recent Browser QA inspection reports, audits, and visual screenshot history for a project.",
    useWhen: ["An authorized Company agent needs to check previous QA inspection results, open issues, or visual audit history."],
    doNotUseWhen: ["The project is archived."],
    agentCallable: true,
    userVisible: true,
    risk: "low",
    requiresConfirmation: false,
    requiredConnections: [],
    requiredPermissions: ["workspace:read"],
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string" },
        reportId: { type: "string", description: "Specific QA report ID (omitted returns latest or list)" },
      },
    },
    version: 1,
  },
];

export const PROJECT_QA_MATRIX: CapabilityMatrixEntry[] = PROJECT_QA_CAPABILITIES.map((capability) => ({
  id: capability.inventoryIds[0]!,
  capabilityId: capability.id,
  name: capability.name,
  type: "tool",
  domain: "orchestration",
  agentCallable: true,
  risk: capability.risk,
  testType: "integration",
  testFiles: ["tests/project-browser-qa.test.ts"],
  status: "VERIFIED_EXISTING",
}));

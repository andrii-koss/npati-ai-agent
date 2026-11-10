import {defaultCapabilityRegistry} from "@npati/shared";
/** References to existing canonical capabilities, never a second schema or permission registry. */
export const CHAT_ROW_CAPABILITIES = ["project.data.rows.list", "project.data.rows.read", "project.data.rows.create", "project.data.rows.update", "project.data.rows.delete"] as const;
export type ChatRowCapability = typeof CHAT_ROW_CAPABILITIES[number];
export function isChatRowCapability(value: unknown): value is ChatRowCapability { return typeof value === "string" && (CHAT_ROW_CAPABILITIES as readonly string[]).includes(value); }
export function rowTaskCapabilities(requested: ChatRowCapability): string[] { return [...new Set([requested, "project.data.schema.inspect", "project.data.rows.list", "project.data.rows.read"])]; }
/** Row reads and inserts also have the project's approval-gated coding executor (code.data.query.read/rows.seed); only
 * update and delete are Company-capability-only. Without a granted Company agent such a task falls through to coding. */
export async function takesRowCapabilityPath(requested: ChatRowCapability, granted: () => Promise<boolean>): Promise<boolean> {
 // Without a company agent that holds the tool, the request goes to the coding agent, which can read, add and delete rows (each
 // write with a confirmation). Updating rows has no coding tool yet, so it stays with the company agents.
 return requested === "project.data.rows.update" || await granted();
}
export function chatCapabilityParameters(id: string): Record<string,unknown> {
 const capability=defaultCapabilityRegistry.get(id);if(!capability?.inputSchema)throw new Error("Unknown canonical capability");
 return {...capability.inputSchema,additionalProperties:false};
}

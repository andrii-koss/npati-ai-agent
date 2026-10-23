import {defaultCapabilityRegistry} from "@npati/shared";
/** References to existing canonical capabilities, never a second schema or permission registry. */
export const CHAT_ROW_CAPABILITIES = ["project.data.rows.list", "project.data.rows.read", "project.data.rows.create", "project.data.rows.update", "project.data.rows.delete"] as const;
export type ChatRowCapability = typeof CHAT_ROW_CAPABILITIES[number];
export function isChatRowCapability(value: unknown): value is ChatRowCapability { return typeof value === "string" && (CHAT_ROW_CAPABILITIES as readonly string[]).includes(value); }
export function rowTaskCapabilities(requested: ChatRowCapability): string[] { return [...new Set([requested, "project.data.schema.inspect", "project.data.rows.list", "project.data.rows.read"])]; }
export function chatCapabilityParameters(id: string): Record<string,unknown> {
 const capability=defaultCapabilityRegistry.get(id);if(!capability?.inputSchema)throw new Error("Unknown canonical capability");
 return {...capability.inputSchema,additionalProperties:false};
}

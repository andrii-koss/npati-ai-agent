
import { CODE_TOOL_SCHEMA_MIRROR_PART1 } from "./code-tool-schema-mirror-part1";
import { CODE_DATA_CAPABILITIES } from "./code-capabilities-data";
import { CODE_ASSIST_CAPABILITIES } from "./code-capabilities-assist";
import { CODE_TOOL_SCHEMA_MIRROR_PART2 } from "./code-tool-schema-mirror-part2";
import { CODE_TOOL_SCHEMA_MIRROR_PART3 } from "./code-tool-schema-mirror-part3";
import { CODE_TOOL_SCHEMA_MIRROR_PART4 } from "./code-tool-schema-mirror-part4";

export const CODE_TOOL_SCHEMA_MIRROR: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  ...Object.fromEntries([...CODE_DATA_CAPABILITIES, ...CODE_ASSIST_CAPABILITIES].map(c => [c.id, { inputSchema: c.inputSchema, outputSchema: c.outputSchema }])),
  ...CODE_TOOL_SCHEMA_MIRROR_PART1,
  ...CODE_TOOL_SCHEMA_MIRROR_PART2,
  ...CODE_TOOL_SCHEMA_MIRROR_PART3,
  ...CODE_TOOL_SCHEMA_MIRROR_PART4,
};

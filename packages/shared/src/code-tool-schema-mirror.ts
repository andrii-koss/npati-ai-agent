/* The code-tool schema mirror as one object: the four parts, spread in their original order. Split out
 * of code-capabilities.ts in step 3d of docs/refactoring/PLAN.md so the capability groups can import it.
 */
import { CODE_TOOL_SCHEMA_MIRROR_PART1 } from "./code-tool-schema-mirror-part1";
import { CODE_TOOL_SCHEMA_MIRROR_PART2 } from "./code-tool-schema-mirror-part2";
import { CODE_TOOL_SCHEMA_MIRROR_PART3 } from "./code-tool-schema-mirror-part3";
import { CODE_TOOL_SCHEMA_MIRROR_PART4 } from "./code-tool-schema-mirror-part4";

export const CODE_TOOL_SCHEMA_MIRROR: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  ...CODE_TOOL_SCHEMA_MIRROR_PART1,
  ...CODE_TOOL_SCHEMA_MIRROR_PART2,
  ...CODE_TOOL_SCHEMA_MIRROR_PART3,
  ...CODE_TOOL_SCHEMA_MIRROR_PART4,
};


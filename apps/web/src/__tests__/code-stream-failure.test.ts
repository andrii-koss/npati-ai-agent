import { expect, it } from "vitest";
import { eventFailure } from "../code-workspace-page-types";

// V6 step 18: a failed dependency install (ok:false, install_failed) looked like a success in the collapsed stream row.
it("marks failed and denied stream events and leaves successful ones unmarked", () => {
  expect(eventFailure({ kind: "code_tool_activity", payload: { tool: "code.deps.add", ok: false, errorCode: "install_failed" } } as never)).toBe("install_failed");
  expect(eventFailure({ kind: "code_tool_activity", payload: { tool: "code.fs.read", ok: false } } as never)).toBe("failed");
  expect(eventFailure({ kind: "policy_decision", payload: { decision: "deny", code: "approval_denied" } } as never)).toBe("approval_denied");
  expect(eventFailure({ kind: "code_tool_activity", payload: { tool: "code.fs.read", ok: true } } as never)).toBeUndefined();
  expect(eventFailure({ kind: "run_activity", payload: {} } as never)).toBeUndefined();
});

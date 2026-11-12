// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../CodeSnapshotPanel", () => ({ CodeSnapshotPanel: () => null }));
import { CodeWorkspaceBottomTabs } from "../code-workspace-bottom-tabs";

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; });

// Live V6 step 04: the Terminal showed six rows of "$ code.shell.exec" and no command or output, although the stored
// project commands held "node -e …" with "V6TEST_OUT_S4" / "V6TEST_ERR_S4" and the running preview process.
it("shows the stored project commands with their output, exit code and running state", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(
    <CodeWorkspaceBottomTabs tab="terminal" setTab={() => {}} isUk={false} sessionId="session" runId="run" companyId="company" changesError={null} changedFiles={[]}
      events={[{ id: "a", kind: "code_tool_activity", payload: { tool: "code.shell.exec", ok: true }, createdAt: "2026-11-12T10:12:50Z" } as never]}
      terminalEvents={[
        { id: "2", runId: "run", commandSummary: "node -e \"console.log('V6TEST_OUT_S4'); console.error('V6TEST_ERR_S4')\"", status: "completed", exitCode: 0, output: "V6TEST_OUT_S4\n\nV6TEST_ERR_S4\n", createdAt: "2026-11-12T10:12:50Z" },
        { id: "1", processId: "process", commandSummary: "npm run start -- --port 3078", status: "running", exitCode: null, output: "", createdAt: "2026-11-12T09:49:02Z" },
      ]} />,
  ));
  const text = host.textContent ?? "";
  expect(text).toContain("$ node -e");
  expect(text).toContain("V6TEST_OUT_S4");
  expect(text).toContain("V6TEST_ERR_S4");
  expect(text).toContain("exit code: 0");
  expect(text).toContain("npm run start -- --port 3078");
  expect(text).toContain("running");
  expect(text).not.toContain("$ code.shell.exec");
  // The stored order is newest first; the terminal reads top to bottom, oldest first.
  expect(text.indexOf("npm run start")).toBeLessThan(text.indexOf("node -e"));
});

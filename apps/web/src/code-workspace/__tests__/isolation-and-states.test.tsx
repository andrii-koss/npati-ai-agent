import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  AccessDeniedState,
  ConnectionLostState,
  EmptyWorkspaceState,
  FlagDisabledNotice,
  SandboxErrorState,
} from "../WorkspaceStates";
import { ControlPanel } from "../ControlPanel";
import { modeChangeRequest, stopRequest } from "../actions";
import type { UsageView } from "../types";

/**
 * [C7-web] [security-gate] isolation and workspace states.
 *
 * The load-bearing assertion is that `forbidden` and `not_found` render **byte-identical** markup: if the
 * two screens differed, the page would tell a user which session ids exist in another company — the
 * existence oracle the server routes were written to avoid.
 */

const usage: UsageView = { tokensIn: 1200, tokensOut: 400, costUsd: 0.0123 };

describe("[C7-web] [security-gate] isolation and states", () => {
  it("renders the same markup for a forbidden and a missing session, with no identifiers", () => {
    const forbidden = renderToStaticMarkup(React.createElement(AccessDeniedState, { kind: "forbidden" }));
    const missing = renderToStaticMarkup(React.createElement(AccessDeniedState, { kind: "not_found" }));
    expect(forbidden).toBe(missing);
    expect(forbidden).not.toContain("sessionId");
    expect(forbidden).not.toContain("company");
    expect(forbidden).not.toContain("403");
    expect(forbidden).not.toContain("404");
  });

  it("explains an empty workspace", () => {
    const markup = renderToStaticMarkup(React.createElement(EmptyWorkspaceState, {}));
    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain("Import a repository");
  });

  it("renders a sandbox failure with its code and retryability", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SandboxErrorState, { code: "network_enforcement_unavailable", retryable: true })
    );
    expect(markup).toContain('data-state="sandbox_error"');
    expect(markup).toContain("network_enforcement_unavailable");
    expect(markup).toContain("retryable");
    expect(markup).toContain("No code was executed");
  });

  it("renders a connection loss as a recoverable state, not an error page", () => {
    const markup = renderToStaticMarkup(React.createElement(ConnectionLostState, {}));
    expect(markup).toContain('data-state="connection_lost"');
    expect(markup).toContain("restored from the last turn");
  });

  it("states what a disabled flag removes and what stays readable", () => {
    const markup = renderToStaticMarkup(React.createElement(FlagDisabledNotice, {}));
    expect(markup).toContain("creating sessions, running, tools, approvals");
    expect(markup).toContain("Read-only: history, Activity, Changes, Export");
  });

  it("disables every state-changing control when the flag is off, keeping read-outs visible", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ControlPanel, {
        companyId: "c1",
        sessionId: "s1",
        revision: 3,
        mode: "ask",
        models: ["auto"],
        model: "auto",
        usage,
        flagEnabled: false,
        onRequest: () => {},
      })
    );
    expect(markup).toContain('data-flag-enabled="false"');
    expect(markup).toContain("disabled");
    expect(markup).toContain('data-field="usage"');
    expect(markup).toContain("$0.0123");
    expect(markup).toContain("revision: 3");
  });

  it("emits the mode change for the session with its revision, and the stop request", () => {
    const modeRequest = modeChangeRequest({ companyId: "c1", sessionId: "s1", mode: "auto_edit", expectedRevision: 3 });
    expect(modeRequest.method).toBe("PUT");
    expect(modeRequest.path).toBe("/companies/c1/code/sessions/s1/mode");
    expect(modeRequest.body).toEqual({ mode: "auto_edit", expectedRevision: 3 });

    const stop = stopRequest({ companyId: "c1", sessionId: "s1" });
    expect(stop.method).toBe("POST");
    expect(stop.path).toBe("/companies/c1/code/sessions/s1/stop");
  });

  it("offers Open Preview only for a web project", () => {
    const base = {
      companyId: "c1",
      sessionId: "s1",
      revision: 1,
      mode: "ask" as const,
      models: ["auto"],
      model: "auto",
      usage,
      onRequest: () => {},
      onOpenPreview: () => {},
    };
    const code = renderToStaticMarkup(React.createElement(ControlPanel, { ...base, isWebProject: false }));
    const web = renderToStaticMarkup(React.createElement(ControlPanel, { ...base, isWebProject: true }));
    expect(code).not.toContain('data-action="open-preview"');
    expect(web).toContain('data-action="open-preview"');
  });

  it("shows usage as unavailable rather than as zero when there is no accounting", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ControlPanel, {
        companyId: "c1",
        sessionId: "s1",
        revision: 1,
        mode: "ask",
        models: ["auto"],
        model: "auto",
        usage: { tokensIn: null, tokensOut: null, costUsd: null, unavailable: "no accounting yet" },
        onRequest: () => {},
      })
    );
    expect(markup).toContain("no accounting yet");
    expect(markup).not.toContain("$0.0000");
  });
});

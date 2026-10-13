import React from "react";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeFlagsPanel, CODE_SUB_FLAGS } from "../../CodeFlagsPanel";

describe("self-hosted coding settings", () => {
  it("initially selects Company as the execution mode", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><CodeFlagsPanel companyId="company-a" isUk={false} notify={() => {}} /></MemoryRouter>);
    expect(markup).toMatch(/<option value="company" selected="">Company<\/option>/);
    expect(markup).not.toMatch(/<option value="global" selected=""/);
    expect(markup).toContain("Sandbox / Data Studio");
  });

  it("exposes the durable session and model profile controls", () => {
    expect(CODE_SUB_FLAGS).toEqual(expect.arrayContaining([
      "code.session_resume", "code.rewind", "code.session_fork", "code.export",
      "code.model_profile.hosted-native-tools", "code.model_profile.local-text-tools",
    ]));
  });
});

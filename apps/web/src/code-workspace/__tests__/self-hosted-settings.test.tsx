import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeFlagsPanel, CODE_SUB_FLAGS } from "../../CodeFlagsPanel";

describe("self-hosted coding settings", () => {
  it("initially selects Global as the change scope", () => {
    const markup = renderToStaticMarkup(<CodeFlagsPanel companyId="company-a" isUk={false} notify={() => {}} />);
    expect(markup).toMatch(/<option value="global" selected="">Global<\/option>/);
    expect(markup).not.toMatch(/<option value="company" selected=""/);
  });

  it("exposes the durable session and model profile controls", () => {
    expect(CODE_SUB_FLAGS).toEqual(expect.arrayContaining([
      "code.session_resume", "code.rewind", "code.session_fork", "code.export",
      "code.model_profile.hosted-native-tools", "code.model_profile.local-text-tools",
    ]));
  });
});

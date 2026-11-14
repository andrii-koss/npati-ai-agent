// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatMessageContent } from "../ChatMessageContent";

// V6 step 12: an automation card showed the cron `30 18 * * *` as "30 18 *": italics ran inside the code span.
it("keeps code spans verbatim in cards while emphasis still works outside them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<ChatMessageContent content={"```card:V6TEST план постів\n**Розклад:** `30 18 * * *` and `0 9 * * 1`\nPlain *italic* text\n```"} />));
  const codes = [...host.querySelectorAll("code")].map(node => node.textContent);
  expect(codes).toEqual(["30 18 * * *", "0 9 * * 1"]);
  expect(host.querySelector("em")?.textContent).toBe("italic");
  expect(host.querySelector("strong")?.textContent).toBe("Розклад:");
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

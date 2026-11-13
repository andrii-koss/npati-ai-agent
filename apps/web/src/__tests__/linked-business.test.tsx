// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it } from "vitest";
import { useLinkedBusiness } from "../linked-business";
import type { WorkspaceOverview } from "../business-workspace-shared";

// V6 step 11: "Open in business goals" from a chat about V6TEST_Bakery2 opened the Goals page of V6TEST_Flowers (the
// user's current Business), which showed "No Goals". The card link now names the Business.
it("shows the linked business at once, makes it current and drops the parameter", async () => {
  const bakery = { id: "bakery", name: "V6TEST_Bakery2" }, flowers = { id: "flowers", name: "V6TEST_Flowers" };
  const overview = { businesses: [flowers, bakery], currentBusiness: flowers } as unknown as WorkspaceOverview;
  const switched: string[] = [], shown: string[] = [];
  let search = "";
  function Probe() {
    shown.push(useLinkedBusiness(overview, async id => { switched.push(id); })?.name ?? "-");
    search = useLocation().search;
    return null;
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MemoryRouter initialEntries={["/settings/goals?business=bakery"]}><Probe /></MemoryRouter>));
  expect(shown[0]).toBe("V6TEST_Bakery2");
  expect(switched).toEqual(["bakery"]);
  expect(search).toBe("");
  // Without the parameter (or with a business the user does not own) the page keeps the current Business.
  shown.length = 0; switched.length = 0;
  await act(async () => root.render(<MemoryRouter initialEntries={["/settings/goals?business=foreign"]}><Probe /></MemoryRouter>));
  expect(shown.at(-1)).toBe("V6TEST_Flowers");
  expect(switched).toEqual([]);
  await act(async () => root.unmount());
});

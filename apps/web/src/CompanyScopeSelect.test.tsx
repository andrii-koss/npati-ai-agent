// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanyScopeSelect } from "./CompanyScopeSelect";

vi.mock("./i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
let root: Root;
let host: HTMLDivElement;
const change = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  change.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CompanyScopeSelect value="all" onValueChange={change} aria-label="Company">
    <option value="all">All companies</option>
    {[<option key="bakery" value="bakery">Sunrise Bakery</option>, <option key="studio" value="studio">Design Studio</option>]}
  </CompanyScopeSelect>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const open = () => act(async () => host.querySelector("button")!.click());
const type = (value: string) => act(async () => {
  const input = document.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("counts companies, searches full names, selects by keyboard and restores focus", async () => {
  await open();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("2 companies");
  expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe("All companies");
  expect(document.activeElement).toBe(document.querySelector("input"));
  await type("  BAKERY  ");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  const input = document.querySelector("input")!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(input.getAttribute("aria-activedescendant")).toBe(document.querySelector('[role="option"]')?.id);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(change).toHaveBeenCalledWith("bakery");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("button"));
});

it("handles no results, Escape, outside clicks and resets search when reopened", async () => {
  await open(); await type("missing");
  expect(document.querySelector('[role="status"]')?.textContent).toBe("No companies found");
  await act(async () => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await open();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

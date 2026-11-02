// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WebsiteProjectCard } from "../website-builder-card";
import { websiteBuilderCopy } from "../website-builder-constants";
import type { WebsiteProject } from "../website-builder-cache";

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; });
const site: WebsiteProject = { id: "proj-1", companyId: "comp-1", name: "Інтернет-магазин", type: "website", status: "ready", revision: 1, updatedAt: "2026-10-18" } as WebsiteProject;

it.each([
  ["uk", "Більше дій", ["Перейменувати", "Дублювати", "Видалити"]],
  ["en", "More options", ["Rename", "Duplicate", "Delete"]],
] as const)("offers Rename, Duplicate and Delete from the card menu in %s", async (language, more, labels) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><WebsiteProjectCard site={site} companyId="comp-1" language={language} t={websiteBuilderCopy[language]}
    handleRename={() => { calls.push("rename"); }} handleDuplicate={() => { calls.push("duplicate"); }} handleDelete={() => { calls.push("delete"); }} /></MemoryRouter>));
  const items = () => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-action-item")];
  expect(items()).toHaveLength(0);
  for (const [index, action] of ["rename", "duplicate", "delete"].entries()) {
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${more}"]`)!.click());
    expect(items().map(item => item.textContent)).toEqual(labels);
    await act(async () => items()[index]!.click());
    expect(calls.at(-1)).toBe(action);
    expect(items()).toHaveLength(0);
  }
});

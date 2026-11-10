// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isAuthenticated: false, isLoading: false }));
vi.mock("../AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../BusinessWorkspace", () => ({ useWorkspace: () => ({ overview: null }) }));
vi.mock("../AuthModal", () => ({ AuthModal: () => null }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./auth-helpers", () => ({ authFetch: vi.fn() }));
import { Home } from "./HomeRoute";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  auth.isAuthenticated = false;
  auth.isLoading = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function Chat() {
  const navigate = useNavigate();
  return <button onClick={() => { auth.isAuthenticated = false; navigate("/"); }}>Sign out</button>;
}

async function render() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/chat" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  ));
}

it("shows the landing page to a signed-out visitor", async () => {
  await render();
  expect(host.querySelector(".home-shell")).not.toBeNull();
});

it("waits for session restoration before showing the landing page", async () => {
  auth.isLoading = true;
  await render();
  expect(host.querySelector(".home-shell")).toBeNull();
  auth.isLoading = false;
  auth.isAuthenticated = true;
  await render();
  expect(host.textContent).toBe("Sign out");
});

it("opens chat for an authenticated visitor and shows landing after sign-out", async () => {
  auth.isAuthenticated = true;
  await render();
  expect(host.querySelector(".home-shell")).toBeNull();
  expect(host.textContent).toBe("Sign out");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector(".home-shell")).not.toBeNull();
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { IntegrationsPage } from "./IntegrationsPage";

vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => null }));
vi.mock("./integrations/InboundWebhooksSection", () => ({ InboundWebhooksSection: () => null }));

it("renders My Connections and the channel cards together from one opening request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<React.StrictMode><MemoryRouter><I18nProvider><IntegrationsPage /></I18nProvider></MemoryRouter></React.StrictMode>));
    expect(fetch.mock.calls).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("/api/integrations/channels?includeCompanies=true", expect.anything());
    expect(host.querySelector(".my-model-row, .provider-card")).toBeNull();
    await act(async () => finish(new Response(JSON.stringify({
      channels: [{ id: "email", name: "Email", available: true, capabilities: [] }],
      connections: [{ id: "inbox", channel: "email", displayName: "Saved inbox", scope: "company", status: "error" }],
      companies: [{ id: "co", name: "Bakery" }],
    }))));
    expect(host.querySelector(".my-model-row")?.textContent).toContain("Saved inbox");
    expect(host.querySelector(".provider-card .provider-title strong")?.textContent).toBe("Email");
    expect(fetch.mock.calls).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

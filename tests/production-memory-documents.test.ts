import { afterEach, describe, expect, it } from "vitest";
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import { MemoryDocumentService } from "../apps/agent-api/src/memory-documents";

const userMarkdown = `# User Profile: Andrii

## Preferred Communication Style
- Language: Ukrainian (uk)
- Style: concise

## Domain & Expertise
- E-commerce

## Active Priorities
- Reliable automation

## Guidelines & Constraints
- Never invent company facts`;

const companyMarkdown = `# Long-Term Memory: Company test

## Core Business Context
- Escalation code MEMORY-7391

## User Preferences
- Ukrainian

## Architectural Decisions
- PostgreSQL is authoritative

## Operational Rules
- Require approval for payments`;

describe("#73 USER.md and #74 MEMORY.md production documents", () => {
  it("persists revisioned documents and isolates user/company scopes", async () => {
    const store = new InMemoryWorkspaceStore();
    const owner: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const outsider: AuthContext = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    await store.initialize(owner);
    await store.initialize(outsider);
    const service = new MemoryDocumentService(store);

    const savedUser = await service.putUserDocument(owner, userMarkdown, 0);
    expect(savedUser.revision).toBe(1);
    expect((await service.getUserDocument(owner))?.markdown).toContain("Andrii");
    expect(await service.getUserDocument(outsider)).toBeNull();
    await expect(service.putUserDocument(owner, "# invalid", savedUser.revision)).rejects.toThrow("USER.md");

    const company = await store.createCompany(owner, { name: "Memory Co" }, "memory-doc-company");
    const savedCompany = await service.putCompanyDocument(owner, company.id, companyMarkdown, company.revision);
    expect(savedCompany.revision).toBe(company.revision + 1);
    expect((await service.getCompanyDocument(owner, company.id))?.markdown).toContain("MEMORY-7391");
    await expect(service.putCompanyDocument(owner, company.id, companyMarkdown + "\n- stale", company.revision)).rejects.toThrow("changed by another request");
    await expect(service.getCompanyDocument(outsider, company.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await service.deleteCompanyDocument(owner, company.id, savedCompany.revision);
    expect(await service.getCompanyDocument(owner, company.id)).toBeNull();
    await service.deleteUserDocument(owner, savedUser.revision);
    expect(await service.getUserDocument(owner)).toBeNull();
  });

  it("exposes authenticated APIs and injects USER.md into real neutral chat assembly", async () => {
    const store = new InMemoryWorkspaceStore();
    let active: AuthContext = { workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
    await store.initialize(active);
    const authProvider: AuthProvider = { authenticate: async () => ({ ...active, permissions: [...active.permissions] }) };
    let requestSeen: ChatRequest | undefined;
    const aiEngine = {
      chat: async (request: ChatRequest) => { requestSeen = request; return { content: "ok" }; },
      stream: async function* () { yield "ok"; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" as const }),
    } satisfies AIEngine;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine });
    await app.ready();

    try {
      const saved = await app.inject({ method: "PUT", url: "/memory/user.md", payload: { markdown: userMarkdown, expectedRevision: 0 } });
      expect(saved.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/memory/user.md" })).json().document.markdown).toContain("Andrii");

      const chat = await app.inject({ method: "POST", url: "/chat", payload: { contextType: "none", message: "How should you answer me?" } });
      expect(chat.statusCode).toBe(200);
      expect(String(requestSeen?.messages[0]?.content)).toContain("User Profile: Andrii");

      active = { workspaceId: "workspace-b", userId: "user-b", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
      await store.initialize(active);
      expect((await app.inject({ method: "GET", url: "/memory/user.md" })).json().document).toBeNull();
    } finally {
      await app.close();
    }
  });
});

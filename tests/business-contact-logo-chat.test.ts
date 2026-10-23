import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../apps/agent-api/src/app";
import { BusinessActionHandler } from "../apps/agent-api/src/business-action-handler";

const alice: AuthContext = { userId: "business-fields-alice", workspaceId: "business-fields-workspace", permissions: ["workspace:read", "business:manage"] };
const bob: AuthContext = { userId: "business-fields-bob", workspaceId: "business-fields-workspace", permissions: ["workspace:read", "business:manage"] };
const action = (value: object) => "Updating the business.\n\n```business-action\n" + JSON.stringify(value) + "\n```";

describe("business legal/contact fields and logo from chat", () => {
  it("updates the selected owned business, preserves omitted profile fields, and stores the attached logo", async () => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(alice, {
      name: "NPATI Studio",
      businessStage: "growing",
      teamType: "team",
      presenceType: "both",
      industry: "Software",
    });
    let persistedName = "";
    const result = await BusinessActionHandler.extractAndExecute(alice, action({
      action: "update",
      businessId: business.id,
      profile: {
        legalName: "NPATI Studio LLC",
        contactEmail: "office@npati.com",
        contactPhone: "+380 44 000 00 00",
        postalAddress: "1 Business Street, Kyiv, Ukraine",
        logoAttachmentName: "npati-logo.png",
      },
    }), store, undefined, undefined, {
      logoAttachments: [{ name: "npati-logo.png", mimeType: "image/png", data: Buffer.from("valid-image"), kind: "image" }],
      persistBusinessLogo: async (context, businessId, attachment) => {
        persistedName = attachment.name;
        return store.updateUserBusiness(context, businessId, { logoFileId: "logo-file-id" });
      },
    });

    expect(result.businessAction).toEqual(expect.objectContaining({ action: "update", businessId: business.id }));
    expect(persistedName).toBe("npati-logo.png");
    expect(await store.getUserBusiness(alice, business.id)).toEqual(expect.objectContaining({
      name: "NPATI Studio",
      businessStage: "growing",
      teamType: "team",
      presenceType: "both",
      industry: "Software",
      legalName: "NPATI Studio LLC",
      contactEmail: "office@npati.com",
      contactPhone: "+380 44 000 00 00",
      postalAddress: "1 Business Street, Kyiv, Ukraine",
      logoFileId: "logo-file-id",
    }));
    expect(result.cleanText).not.toContain("business-action");
  });

  it("does not accept missing logo files, invalid email, or another user's business", async () => {
    const store = new InMemoryWorkspaceStore();
    const aliceBusiness = await store.createBusiness(alice, { name: "Alice Business", businessStage: "operating" });
    const bobBusiness = await store.createBusiness(bob, { name: "Bob Business", businessStage: "operating" });
    let persisted = 0;
    const options = {
      logoAttachments: [{ name: "other.png", mimeType: "image/png", data: Buffer.from("image"), kind: "image" }],
      persistBusinessLogo: async () => { persisted++; throw new Error("must not run"); },
    };

    const missingLogo = await BusinessActionHandler.extractAndExecute(alice, action({
      action: "update", businessId: aliceBusiness.id,
      profile: { legalName: "Must not be written", logoAttachmentName: "missing.png" },
    }), store, undefined, undefined, options);
    const invalidEmail = await BusinessActionHandler.extractAndExecute(alice, action({
      action: "update", businessId: aliceBusiness.id, profile: { contactEmail: "not-an-email" },
    }), store);
    const foreign = await BusinessActionHandler.extractAndExecute(alice, action({
      action: "update", businessId: bobBusiness.id, profile: { legalName: "Stolen" },
    }), store);

    expect(missingLogo.businessAction).toBeUndefined();
    expect(invalidEmail.businessAction).toBeUndefined();
    expect(foreign.businessAction).toBeUndefined();
    expect(persisted).toBe(0);
    expect((await store.getUserBusiness(alice, aliceBusiness.id)).legalName).toBeUndefined();
    expect((await store.getUserBusiness(bob, bobBusiness.id)).legalName).toBeUndefined();
  });

  it("teaches the planner about the new fields without exposing a writable logo ID", () => {
    const prompt = BusinessActionHandler.buildSystemPrompt([]);
    expect(prompt).toContain("legalName");
    expect(prompt).toContain("contactEmail");
    expect(prompt).toContain("contactPhone");
    expect(prompt).toContain("postalAddress");
    expect(prompt).toContain("logoAttachmentName");
    expect(prompt).toContain("Never invent or accept a logoFileId");
  });

  it("persists a real logo attachment through the streamed business chat route", async () => {
    let businessId = "";
    const output = () => action({
      action: "update",
      businessId,
      profile: {
        legalName: "Chat Route LLC",
        contactEmail: "hello@chat-route.test",
        contactPhone: "+380 50 123 45 67",
        postalAddress: "Kyiv, Ukraine",
        logoAttachmentName: "brand.png",
      },
    });
    const aiEngine: AIEngine = {
      chat: async () => ({ content: output() }),
      async *stream() { yield output(); },
      listModels: async () => [],
      getModel: async () => undefined,
      executeTool: async () => undefined,
      searchMemory: async () => [],
      saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"],
      healthCheck: async () => ({ status: "ok" }),
    };
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "npati-business-logo-chat-"));
    const store = new InMemoryWorkspaceStore();
    const app = buildApp({ workspaceStore: store, aiEngine, marketplace, dataDirectory });
    try {
      const created = await app.inject({ method: "POST", url: "/businesses", payload: { name: "Chat Route", businessStage: "operating" } });
      businessId = created.json().id;
      const response = await app.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          contextType: "business",
          businessId,
          message: "Заповни юридичні контакти та встанови прикріплене зображення як логотип.",
          attachments: [{
            kind: "image",
            name: "brand.png",
            mimeType: "image/png",
            dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAElFTkSuQmCC",
          }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"businessAction":{"action":"update"');
      const saved = (await app.inject({ method: "GET", url: "/businesses/" + businessId })).json();
      expect(saved).toEqual(expect.objectContaining({
        legalName: "Chat Route LLC",
        contactEmail: "hello@chat-route.test",
        contactPhone: "+380 50 123 45 67",
        postalAddress: "Kyiv, Ukraine",
      }));
      expect(saved.logoFileId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await app.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

it("updates only supplied Goal fields without requiring the title again", async () => {
 const store=new InMemoryWorkspaceStore();const business=await store.createBusiness(alice,{name:"Goal patch test",businessStage:"operating"});const goal=await store.createGoal(alice,business.id,{title:"Original launch",description:"Before",priority:2,status:"paused"});
 const result=await BusinessActionHandler.extractAndExecute(alice,"```goal-action\n"+JSON.stringify({action:"update",businessId:business.id,goalId:goal.id,goal:{description:"Catálogo con datos reales"}})+"\n```",store);
 expect(result.goalAction?.action).toBe("update");expect((await store.listGoals(alice,business.id))[0]).toMatchObject({id:goal.id,title:"Original launch",description:"Catálogo con datos reales",priority:2,status:"paused"});
});

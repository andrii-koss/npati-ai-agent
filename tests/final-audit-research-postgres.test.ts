import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore } from "@npati/workspace";
import { databaseDescribe } from "./support/database-describe";
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseDescribe(Boolean(databaseUrl && process.env.NPATI_SECURITY_GATE_DB === "1"), describe, describe.skip);
suite("final audit: durable research and goal assignee migrations", () => {
 it("preserves exact research across reconnects, enforces ownership and cascades deletion", async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const name = "npati_final_audit_" + randomUUID().replaceAll("-", "");
  const url = new URL(databaseUrl!); url.pathname = "/" + name;
  let store: PostgresWorkspaceStore | undefined; let pool: Pool | undefined;
  const alice = { userId: "audit-alice", workspaceId: "audit-ws", permissions: ["workspace:read", "workspace:write", "business:manage"] };
  const bob = { ...alice, userId: "audit-bob" };
  try {
   await admin.query(`CREATE DATABASE "${name}"`);
   store = new PostgresWorkspaceStore(url.href); await store.initialize(alice); await store.initialize(bob);
   pool = new Pool({ connectionString: url.href });
   const chat = await store.createNeutralConversation(alice, "Chat A");
   const company = await store.createCompany(alice, { name: "Audit company" }, "company");
   const agent = await store.createCompanyAgent(alice, company.id, { name: "Assignee", role: "Worker" }, "agent");
   const business = await store.createBusiness(alice, { name: "Audit business", businessStage: "operating" });
   const goal = await store.createGoal(alice, business.id, { title: "Survives deleted agent", assignedAgentId: agent.id });
   await expect(store.createGoal(bob, (await store.createBusiness(bob, { name: "Bob", businessStage: "starting" })).id, { title: "Forbidden", assignedAgentId: agent.id })).rejects.toThrow();
   const input = { companyId: company.id, tool: "web_fetch", kind: "url_analysis", query: "initial three websites", pageCount: 29, sources: Array.from({ length: 32 }, (_, n) => ({ url: `https://example.com/${n}`, accessedAt: "2026-10-24T00:00:00Z" })), evidenceExcerpt: "Exact evidence\n".repeat(500) };
   await store.appendConversationResearch(alice, chat.id, input);
   await store.close(); store = new PostgresWorkspaceStore(url.href); await store.initialize(alice);
   expect((await store.listConversationResearch(alice, chat.id))[0]).toMatchObject({ ...input, sourceCount: 32 });
   await expect(store.listConversationResearch(bob, chat.id)).rejects.toThrow();
   await expect(store.appendConversationResearch(bob, (await store.createNeutralConversation(bob, "Bob")).id, input)).rejects.toThrow();
   await store.deleteCompanyAgent(alice, company.id, agent.id, agent.revision);
   expect((await store.listGoals(alice, business.id)).find(item => item.id === goal.id)?.assignedAgentId).toBeNull();
   await store.deleteNeutralConversation(alice, chat.id);
   expect((await pool.query("SELECT 1 FROM conversation_research_evidence WHERE conversation_id=$1", [chat.id])).rowCount).toBe(0);
  } finally {
   await pool?.end(); await store?.close();
   await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  }
 }, 180_000);
});

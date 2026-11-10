import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import type { AuditLogService } from "../apps/agent-api/src/audit-log";

const owner: AuthContext = { userId: "owner", workspaceId: "auto-allow", permissions: ["admin:all", "workspace:read", "workspace:write"] };
const member: AuthContext = { ...owner, externalSubject: "npati:apikey:read-only" };

async function setup(withAudit = true) {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(owner, { name: "Bakery" }, "auto-allow-company");
  const audit = { record: vi.fn(async () => undefined) };
  const flags = new FeatureFlagService(store, withAudit ? audit as unknown as AuditLogService : undefined, { enabledByDefault: true });
  return { company, audit, setting: flags.dataAutoAllow };
}

describe("company setting: change databases without asking", () => {
  it("is off for a new company", async () => {
    const { company, setting } = await setup();
    expect(await setting.get(owner, company.id)).toEqual({ autoAllow: false, revision: 0, canChange: true });
    expect(await setting.isOn(owner, company.id)).toBe(false);
  });

  it("an owner turns it on and off; each change is audited first and checked against the revision", async () => {
    const { company, audit, setting } = await setup();
    const on = await setting.set(owner, company.id, true, 0);
    expect(on.autoAllow).toBe(true);
    expect(await setting.isOn(owner, company.id)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(owner, expect.objectContaining({ action: "chat.data_auto_allow.change", payload: expect.objectContaining({ previous: false, next: true }) }));
    await expect(setting.set(owner, company.id, false, 0)).rejects.toMatchObject({ code: "setting_revision_conflict", status: 409 });
    expect((await setting.set(owner, company.id, false, on.revision)).autoAllow).toBe(false);
  });

  it("an API key or anyone else who cannot manage the company sees it but cannot change it", async () => {
    const { company, setting } = await setup();
    expect((await setting.get(member, company.id)).canChange).toBe(false);
    await expect(setting.set(member, company.id, true, 0)).rejects.toMatchObject({ code: "company_admin_required", status: 403 });
    expect(await setting.isOn(owner, company.id)).toBe(false);
  });

  it("is not changed without an audit journal", async () => {
    const { company, setting } = await setup(false);
    await expect(setting.set(owner, company.id, true, 0)).rejects.toMatchObject({ code: "audit_unavailable" });
    expect(await setting.isOn(owner, company.id)).toBe(false);
  });
});

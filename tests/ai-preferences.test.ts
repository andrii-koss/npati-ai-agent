import { AIPreferencesStore } from '../apps/agent-api/src/ai-preferences';
import type { AIModelSummary } from '@npati/omniroute-adapter';
import { InMemoryWorkspaceStore, type AuthContext } from '@npati/workspace';
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let workspace: InMemoryWorkspaceStore;
let store: AIPreferencesStore;
const owner: AuthContext = { workspaceId: 'workspace-a', userId: 'user-a', permissions: ['workspace:read', 'workspace:write'] };
const otherTenant: AuthContext = { workspaceId: 'workspace-b', userId: 'user-b', permissions: ['workspace:read', 'workspace:write'] };
const model: AIModelSummary = { id: 'openai/gpt-test', upstreamId: 'gpt-test', providerId: 'openai', providerName: 'OpenAI', name: 'GPT Test', capabilities: ['text'], added: false, local: false, freeStatus: 'unknown' };
const otherModel: AIModelSummary = { id: 'anthropic/claude-test', upstreamId: 'claude-test', providerId: 'anthropic', providerName: 'Anthropic', name: 'Claude Test', capabilities: ['text'], added: false, local: false, freeStatus: 'unknown' };

beforeEach(() => { workspace = new InMemoryWorkspaceStore(); store = new AIPreferencesStore(workspace); });

describe('NPATI AI preferences', () => {
  it('13. adds a model once, including concurrent retries', async () => {
    await Promise.all(Array.from({ length: 20 }, () => store.add(owner, model)));
    expect((await store.get(owner)).addedModels).toHaveLength(1);
    expect((await store.get(owner)).routing.defaultModelId).toBe(model.id);
  });

  it('14. removes a model', async () => {
    await store.add(owner, model); await store.remove(owner, model.id);
    expect((await store.get(owner)).addedModels).toEqual([]);
  });

  it('14a. removes every model owned by a disconnected provider and resets its default route', async () => {
    await store.add(owner, model);
    await store.add(owner, { ...model, id: 'openai/gpt-second', upstreamId: 'gpt-second' });
    await store.add(owner, otherModel);
    await store.setDefault(owner, model.id);

    const result = await store.removeProvider(owner, 'openai');

    expect(result.addedModels.map((item) => item.id)).toEqual([otherModel.id]);
    expect(result.routing).toMatchObject({ mode: 'automatic', defaultModelId: null });
  });

  it('15. selects one default model', async () => {
    await store.add(owner, model); await store.setDefault(owner, model.id);
    expect((await store.get(owner)).routing).toMatchObject({ mode: 'manual', defaultModelId: model.id });
  });

  it('16. stores Automatic mode using the verified auto model', async () => {
    await store.setRouting(owner, 'automatic');
    expect((await store.get(owner)).routing).toMatchObject({
      mode: 'automatic', defaultModelId: null, automaticModel: 'auto/chat:free', preferFree: true,
      fallbackOnFailure: true, balanceQualityCost: true, compression: 'stacked', monthlyBudgetUsd: 20,
      warningPercent: 80, stopPaidWhenLimitReached: true,
    });
  });

  it('17. requires an added default for Manual mode', async () => {
    await expect(store.setRouting(owner, 'manual', model.id)).rejects.toThrow('My Models');
    await store.add(owner, model);
    await expect(store.setRouting(owner, 'manual', model.id)).resolves.toMatchObject({ routing: { mode: 'manual', defaultModelId: model.id } });
  });

  it('17a. switches to Manual using the first added model when legacy default is missing', async () => {
    await workspace.setUserSetting(owner, 'ai.preferences', {
      addedModels: [model],
      routing: { mode: 'automatic', defaultModelId: null },
    }, 0);
    await expect(store.setRouting(owner, 'manual')).resolves.toMatchObject({
      routing: { mode: 'manual', defaultModelId: model.id },
    });
  });

  it('18. persists routing preferences without leaking them to another tenant', async () => {
    await store.add(owner, model);
    await store.setRouting(owner, 'automatic', null, {
      preferFree: false, fallbackOnFailure: false, balanceQualityCost: false, compression: 'off',
      monthlyBudgetUsd: 35, warningPercent: 75, stopPaidWhenLimitReached: false,
    });
    expect((await store.get(owner)).routing).toMatchObject({ automaticModel: 'auto/smart', monthlyBudgetUsd: 35 });
    expect(await store.get(otherTenant)).toMatchObject({ addedModels: [], routing: { automaticModel: 'auto/chat:free', monthlyBudgetUsd: 20 } });
  });

  it('19. isolates users inside the same workspace', async () => {
    const secondUser = { ...owner, userId: 'user-b' };
    await store.add(owner, model);
    expect((await store.get(secondUser)).addedModels).toEqual([]);
  });

  it('20. imports the legacy local My Models file exactly once', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'npati-legacy-models-'));
    try {
      await writeFile(path.join(directory, 'ai-preferences.json'), JSON.stringify({
        addedModels: [model],
        routing: { mode: 'manual', defaultModelId: model.id },
      }));
      const localScope: AuthContext = { workspaceId: 'dev-workspace', userId: 'dev-user', permissions: ['workspace:read'] };
      const migrated = new AIPreferencesStore(workspace, directory);
      expect(await migrated.get(localScope)).toMatchObject({
        addedModels: [{ id: model.id }],
        routing: { mode: 'manual', defaultModelId: model.id },
      });
      await writeFile(path.join(directory, 'ai-preferences.json'), JSON.stringify({ addedModels: [], routing: {} }));
      expect((await migrated.get(localScope)).addedModels).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('21. never falls back to or mirrors dev-workspace across authenticated scopes', async () => {
    const localScope: AuthContext = { workspaceId: 'dev-workspace', userId: 'dev-user', permissions: ['workspace:read', 'workspace:write'] };
    const authenticatedDevUser: AuthContext = { workspaceId: 'workspace:dev-user', userId: 'dev-user', permissions: ['workspace:read', 'workspace:write'] };
    await store.add(localScope, model);
    expect((await store.get(authenticatedDevUser)).addedModels).toEqual([]);
    await store.add(authenticatedDevUser, otherModel);
    expect((await store.get(localScope)).addedModels.map((item) => item.id)).toEqual([model.id]);
    expect((await store.get(authenticatedDevUser)).addedModels.map((item) => item.id)).toEqual([otherModel.id]);
  });
});

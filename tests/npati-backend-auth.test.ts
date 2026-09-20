import { buildApp } from "../apps/agent-api/src/app";
import { createMockNpatiJwt, NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type {
  NpatiAuthClient,
  NpatiAuthResponse,
  NpatiAuthTokens,
  NpatiLoginInput,
  NpatiRegisterInput,
  NpatiUser,
} from "@npati/hub-connector";
import { afterEach, describe, expect, it } from "vitest";

const JWT_SECRET = "test-npati-jwt-secret-key-32chars!!";

class MockNpatiAuthBackend implements NpatiAuthClient {
  public registeredUsers = new Map<string, {
    id: string;
    email: string;
    username: string;
    name?: string;
    password: string;
    role: string;
  }>();
  public revokedTokens = new Set<string>();

  async register(input: NpatiRegisterInput): Promise<NpatiAuthResponse> {
    if (this.registeredUsers.has(input.email.toLowerCase())) {
      throw new Error("Email already registered");
    }
    const id = `npati-user-${this.registeredUsers.size + 1}`;
    const userRecord = {
      id,
      email: input.email.toLowerCase(),
      username: input.username,
      name: input.displayName,
      password: input.password,
      role: "user",
    };
    this.registeredUsers.set(input.email.toLowerCase(), userRecord);

    const accessToken = createMockNpatiJwt({ userId: id, email: input.email, role: "user" }, JWT_SECRET, 3600);
    const refreshToken = `mock-refresh-${id}`;
    return {
      tokens: { accessToken, refreshToken, expiresIn: 3600 },
      user: {
        id,
        email: input.email,
        username: userRecord.username,
        displayName: userRecord.name,
        name: userRecord.name,
        role: "user",
      },
    };
  }

  async login(input: NpatiLoginInput): Promise<NpatiAuthResponse> {
    const user = this.registeredUsers.get(input.email.toLowerCase());
    if (!user || user.password !== input.password) {
      const err = new Error("Invalid email or password");
      (err as unknown as { status: number }).status = 401;
      throw err;
    }
    const accessToken = createMockNpatiJwt({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, 3600);
    const refreshToken = `mock-refresh-${user.id}`;
    return {
      tokens: { accessToken, refreshToken, expiresIn: 3600 },
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.name,
        name: user.name,
        role: user.role,
      },
    };
  }

  async refresh(refreshToken: string): Promise<{ tokens: NpatiAuthTokens }> {
    if (this.revokedTokens.has(refreshToken) || !refreshToken.startsWith("mock-refresh-")) {
      const err = new Error("Invalid or revoked refresh token");
      (err as unknown as { status: number }).status = 401;
      throw err;
    }
    const userId = refreshToken.replace("mock-refresh-", "");
    const accessToken = createMockNpatiJwt({ userId, email: `${userId}@npati.test`, role: "user" }, JWT_SECRET, 3600);
    return { tokens: { accessToken, refreshToken, expiresIn: 3600 } };
  }

  async logout(refreshToken?: string): Promise<{ success: boolean; message?: string }> {
    if (refreshToken) this.revokedTokens.add(refreshToken);
    return { success: true, message: "Logged out successfully." };
  }

  async getCurrentUser(token: string): Promise<NpatiUser> {
    if (this.revokedTokens.has(token)) {
      const err = new Error("Token revoked");
      (err as unknown as { status: number }).status = 401;
      throw err;
    }
    return { id: "user-test", email: "user@test.com", username: "user-test", role: "user" };
  }
}

function createTestAiEngine(): AIEngine {
  return {
    chat: async () => ({ content: "Hello from NPATI Agent" }),
    stream: async function* () {
      yield "Hello ";
      yield "from ";
      yield "NPATI Agent";
    },
    listModels: async () => [],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    searchMemory: async () => [],
    saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"],
    healthCheck: async () => ({ status: "ok" as const }),
    resilienceStatus: async () => ({
      source: "omniroute" as const,
      configuration: { waitForCooldown: { enabled: true, maxRetries: 1 } },
      runtime: { status: "healthy", providerBreakers: [], lockouts: [], adaptiveAdmission: {}, chatAdmission: {} },
    }),
  } satisfies AIEngine;
}

describe("NPATI Backend Authentication & Single Source of Truth Integration", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function setupApp(options?: { strictAuth?: boolean; allowLegacyPasswordAuth?: boolean }) {
    const mockBackend = new MockNpatiAuthBackend();
    const workspaceStore = new InMemoryWorkspaceStore();
    const authProvider = new NpatiBackendAuthProvider({
      jwtSecret: JWT_SECRET,
      workspaceStore,
      authClient: mockBackend,
      allowDevFallback: !(options?.strictAuth ?? true),
    });

    const app = buildApp({
      workspaceStore,
      authProvider,
      authClient: mockBackend,
      strictAuth: options?.strictAuth ?? true,
      npatiJwtSecret: JWT_SECRET,
      allowLegacyPasswordAuth: options?.allowLegacyPasswordAuth ?? true,
      aiEngine: createTestAiEngine(),
      marketplace: { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace,
    });
    apps.push(app);

    return { app, mockBackend, workspaceStore, authProvider };
  }

  it("rejects direct password collection when legacy auth is disabled", async () => {
    const { app, mockBackend } = setupApp({ allowLegacyPasswordAuth: false });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.com", password: "should-not-leave-browser" },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("CENTRAL_ACCOUNT_CONNECTION_REQUIRED");
    expect(mockBackend.registeredUsers.size).toBe(0);
  });
  it("registers a new user via NPATI backend and returns tokens and user info", async () => {
    const { app } = setupApp();

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "alice@example.com",
        password: "securePassword123!",
        name: "Alice Wonderland",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokens.accessToken).toBeDefined();
    expect(body.tokens.refreshToken).toBeDefined();
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.name).toBe("Alice Wonderland");
    expect(body.user.id).toBe("npati-user-1");
  });

  it("authenticates existing user via NPATI backend login", async () => {
    const { app, mockBackend } = setupApp();

    // Register user first in backend
    await mockBackend.register({
      email: "bob@example.com",
      password: "bobPassword456!",
      username: "bob",
      displayName: "Bob Builder",
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "bob@example.com",
        password: "bobPassword456!",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokens.accessToken).toBeDefined();
    expect(body.user.email).toBe("bob@example.com");
    expect(body.user.name).toBe("Bob Builder");
  });

  it("never authenticates the historical test login after the main backend rejects it", async () => {
    const { app } = setupApp({ strictAuth: true });
    const res = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email: "webuser1@example.com", password: "Password123!" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().tokens).toBeUndefined();
    expect(res.json().data?.tokens).toBeUndefined();
  });

  it("never falls back to development identity for an invalid supplied token", async () => {
    const { app } = setupApp({ strictAuth: false });
    const res = await app.inject({
      method: "GET", url: "/workspace/context",
      headers: { authorization: "Bearer invalid" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("never authenticates the historical test login after the main backend rejects it", async () => {
    const { app } = setupApp({ strictAuth: true });
    const res = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email: "webuser1@example.com", password: "Password123!" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().tokens).toBeUndefined();
    expect(res.json().data?.tokens).toBeUndefined();
  });

  it("never falls back to development identity for an invalid supplied token", async () => {
    const { app } = setupApp({ strictAuth: false });
    const res = await app.inject({
      method: "GET", url: "/workspace/context",
      headers: { authorization: "Bearer invalid" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects login with invalid credentials with 401 Unauthorized", async () => {
    const { app, mockBackend } = setupApp();

    await mockBackend.register({
      email: "carol@example.com",
      password: "correctPassword",
      username: "carol",
      displayName: "Carol Danvers",
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "carol@example.com",
        password: "wrongPassword",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.message).toMatch(/invalid email or password/i);
  });

  it("rejects requests with missing token when strictAuth is enabled", async () => {
    const { app } = setupApp({ strictAuth: true });

    const res = await app.inject({
      method: "GET",
      url: "/workspace/context",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.message).toMatch(/token/i);
  });

  it("rejects requests with an expired JWT token", async () => {
    const { app } = setupApp({ strictAuth: true });

    // Create token expired 10 seconds ago
    const expiredToken = createMockNpatiJwt(
      { userId: "user-expired", email: "expired@test.com", role: "user" },
      JWT_SECRET,
      -10,
    );

    const res = await app.inject({
      method: "GET",
      url: "/workspace/context",
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.message).toMatch(/token has expired/i);
  });

  it("rejects requests with tampered JWT token or invalid secret", async () => {
    const { app } = setupApp({ strictAuth: true });

    const tamperedToken = createMockNpatiJwt(
      { userId: "user-tampered", email: "hacker@test.com", role: "admin" },
      "different-wrong-secret-key-that-fails",
      3600,
    );

    const res = await app.inject({
      method: "GET",
      url: "/workspace/context",
      headers: {
        authorization: `Bearer ${tamperedToken}`,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.message).toMatch(/signature/i);
  });

  it("initializes workspace lazily on first access for a valid authenticated user", async () => {
    const { app, workspaceStore } = setupApp({ strictAuth: true });

    const token = createMockNpatiJwt(
      { userId: "user-brand-new", email: "newuser@test.com", role: "user" },
      JWT_SECRET,
      3600,
    );

    const res = await app.inject({
      method: "GET",
      url: "/workspace/context",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspace.id).toBe("workspace:user-brand-new");
    expect(body.user.id).toBe("user-brand-new");

    // Verify workspace exists in the store
    const storeOverview = await workspaceStore.overview({
      userId: "user-brand-new",
      workspaceId: "workspace:user-brand-new",
      permissions: ["workspace:read"],
    });
    expect(storeOverview.user.id).toBe("user-brand-new");
  });

  it("strictly enforces tenant isolation between User A and User B", async () => {
    const { app } = setupApp({ strictAuth: true });

    const tokenUserA = createMockNpatiJwt(
      { userId: "user-alpha", email: "alpha@test.com", role: "user" },
      JWT_SECRET,
      3600,
    );

    const tokenUserB = createMockNpatiJwt(
      { userId: "user-beta", email: "beta@test.com", role: "user" },
      JWT_SECRET,
      3600,
    );

    // User A creates a business
    const createBizRes = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { authorization: `Bearer ${tokenUserA}` },
      payload: {
        name: "Alpha Confidential Corp",
        description: "Private assets for user alpha only",
      },
    });
    expect(createBizRes.statusCode).toBe(201);
    const bizA = createBizRes.json();
    expect(bizA.id).toBeDefined();

    // User A creates a conversation in business A
    const createChatRes = await app.inject({
      method: "POST",
      url: `/businesses/${bizA.id}/conversations`,
      headers: { authorization: `Bearer ${tokenUserA}` },
      payload: { title: "Alpha Strategy" },
    });
    expect(createChatRes.statusCode).toBe(201);
    const chatA = createChatRes.json();

    // User A can see business A
    const userAOverview = await app.inject({
      method: "GET",
      url: "/workspace/context",
      headers: { authorization: `Bearer ${tokenUserA}` },
    });
    expect(userAOverview.statusCode).toBe(200);
    expect(userAOverview.json().businesses.some((b: { id: string }) => b.id === bizA.id)).toBe(true);

    // User B checks their own overview — must NOT see User A's business
    const userBOverview = await app.inject({
      method: "GET",
      url: "/workspace/context",
      headers: { authorization: `Bearer ${tokenUserB}` },
    });
    expect(userBOverview.statusCode).toBe(200);
    expect(userBOverview.json().businesses.some((b: { id: string }) => b.id === bizA.id)).toBe(false);

    // User B attempts to directly read User A's conversation -> must be denied (403 or 404)
    const userBStealChat = await app.inject({
      method: "GET",
      url: `/businesses/${bizA.id}/conversations/${chatA.id}`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });
    expect([403, 404]).toContain(userBStealChat.statusCode);

    // User B attempts to post message to User A's chat -> must be denied (403 or 404)
    const userBPostToChat = await app.inject({
      method: "POST",
      url: `/businesses/${bizA.id}/conversations/${chatA.id}/messages`,
      headers: { authorization: `Bearer ${tokenUserB}` },
      payload: { content: "Intruder message" },
    });
    expect([403, 404]).toContain(userBPostToChat.statusCode);

    // User B attempts to delete User A's business -> must be denied (403 or 404)
    const userBDeleteBiz = await app.inject({
      method: "DELETE",
      url: `/businesses/${bizA.id}`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });
    expect([403, 404]).toContain(userBDeleteBiz.statusCode);
  });

  it("supports user logout and token refresh through the NPATI backend proxy", async () => {
    const { app, mockBackend } = setupApp();

    const reg = await mockBackend.register({
      email: "dave@example.com",
      password: "password123",
      username: "dave",
      displayName: "Dave",
    });

    const refreshToken = reg.tokens.refreshToken;
    expect(refreshToken).toBeDefined();

    // Refresh token
    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().tokens.accessToken).toBeDefined();

    // Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
      headers: { authorization: `Bearer ${reg.tokens.accessToken}` },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().success).toBe(true);
    expect(mockBackend.revokedTokens.has(refreshToken!)).toBe(true);
  });

  it("runs chat and stream with valid Bearer token and rejects unauthenticated chat under strictAuth", async () => {
    const { app } = setupApp({ strictAuth: true });

    // Unauthenticated chat rejected
    const unauthChat = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Hello" },
    });
    expect(unauthChat.statusCode).toBe(401);

    // Unauthenticated stream rejected
    const unauthStream = await app.inject({
      method: "POST",
      url: "/chat/stream",
      payload: { message: "Hello" },
    });
    expect(unauthStream.statusCode).toBe(401);

    // Authenticated chat succeeds
    const token = createMockNpatiJwt(
      { userId: "user-chat-tester", email: "tester@npati.test", role: "user" },
      JWT_SECRET,
      3600,
    );

    const authChat = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Hello NPATI Agent" },
    });
    expect(authChat.statusCode).toBe(200);
    expect(authChat.json().message).toBeDefined();
  });
});

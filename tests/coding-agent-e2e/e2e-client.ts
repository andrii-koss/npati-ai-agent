import crypto from "node:crypto";

export interface E2EConfig {
  baseUrl: string;
  jwtSecret: string;
  userId: string;
  workspaceId: string;
  knownSecrets: string[];
}

export const defaultConfig: E2EConfig = {
  baseUrl: process.env.AGENT_API_URL ?? "http://127.0.0.1:13002",
  jwtSecret: process.env.NPATI_JWT_SECRET ?? "e2e-test-jwt-secret-at-least-32-chars-long-123456",
  userId: "e2e-smoke-user",
  workspaceId: "workspace:e2e-smoke-user",
  knownSecrets: [
    "e2e-test-jwt-secret-at-least-32-chars-long-123456",
    process.env.POSTGRES_PASSWORD ?? "",
    process.env.OMNIROUTE_API_KEY ?? "",
    process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "",
    "e2e-preview-secret-test-32-chars-long-abcdef",
  ].filter(Boolean),
};

function base64url(str: string | Buffer): string {
  const buf = typeof str === "string" ? Buffer.from(str, "utf8") : str;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function createJwtToken(options: {
  userId?: string;
  workspaceId?: string;
  role?: string;
  permissions?: string[];
  expSeconds?: number;
  secret?: string;
} = {}): string {
  const secret = options.secret ?? defaultConfig.jwtSecret;
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      userId: options.userId ?? defaultConfig.userId,
      workspaceId: options.workspaceId ?? defaultConfig.workspaceId,
      role: options.role ?? "owner",
      permissions: options.permissions ?? ["*"],
      exp: Math.floor(Date.now() / 1000) + (options.expSeconds ?? 3600),
    }),
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${payload}.${signature}`;
}

export interface ChatStreamEvent {
  event: string;
  id?: string;
  data: any;
}

export interface ChatStreamOutcome {
  events: ChatStreamEvent[];
  text: string;
  progressEvents: any[];
  resultEvent?: any;
  errorEvent?: any;
  durationMs: number;
}

export async function sendChatStream(input: {
  message: string;
  conversationId?: string;
  companyId?: string;
  projectId?: string;
  token?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<ChatStreamOutcome> {
  const start = Date.now();
  const baseUrl = input.baseUrl ?? defaultConfig.baseUrl;
  const token = input.token ?? createJwtToken();
  const timeoutMs = input.timeoutMs ?? 120_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: input.message,
        conversationId: input.conversationId,
        companyId: input.companyId,
        projectId: input.projectId,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let errJson;
      try { errJson = JSON.parse(errText); } catch { /* ignore */ }
      throw Object.assign(
        new Error(`Chat stream HTTP ${res.status}: ${errText}`),
        { status: res.status, body: errJson ?? errText },
      );
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";
    const events: ChatStreamEvent[] = [];
    const progressEvents: any[] = [];
    let text = "";
    let resultEvent: any;
    let errorEvent: any;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim() || part.startsWith(":")) continue; // heartbeat or comment
        const lines = part.split("\n");
        let currentEvent = "message";
        let currentId: string | undefined;
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
          } else if (line.startsWith("data: ")) {
            dataStr += line.slice(6);
          }
        }

        let parsedData: any = dataStr;
        try {
          parsedData = JSON.parse(dataStr);
        } catch {
          // keep as raw text
        }

        const ev: ChatStreamEvent = { event: currentEvent, id: currentId, data: parsedData };
        events.push(ev);

        if (currentEvent === "progress") {
          progressEvents.push(parsedData);
        } else if (currentEvent === "delta") {
          if (typeof parsedData === "string") text += parsedData;
          else if (parsedData && typeof parsedData.text === "string") text += parsedData.text;
          else if (parsedData && typeof parsedData.chunk === "string") text += parsedData.chunk;
        } else if (currentEvent === "result") {
          resultEvent = parsedData;
        } else if (currentEvent === "error") {
          errorEvent = parsedData;
        }
      }
    }

    return {
      events,
      text,
      progressEvents,
      resultEvent,
      errorEvent,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function assertNoSecretsLeaked(payload: any, secrets: string[] = defaultConfig.knownSecrets): void {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const secret of secrets) {
    if (!secret || secret.length < 16) continue;
    if (serialized.includes(secret)) {
      throw new Error(`Security assertion failed: Secret leaked in payload! Secret prefix: ${secret.slice(0, 6)}...`);
    }
  }
}

export interface DomInteractionResult {
  title: string;
  headerText: string;
  buttonFound: boolean;
  initialCounterText: string;
  afterClickCounterText: string;
  buttonColor?: string;
  resetButtonFound?: boolean;
  afterResetCounterText?: string;
  success: boolean;
}

export async function testLivePreviewDom(url: string): Promise<DomInteractionResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });

    const title = await page.title();
    const headerEl = await page.$("h1, h2, #title, .title");
    const headerText = headerEl ? (await headerEl.innerText()).trim() : "";

    // Find Click Me button
    const clickBtn =
      (await page.$("button:has-text('Click Me')")) ||
      (await page.$("#click-me, #click-btn, #btn-click, button"));
    const buttonFound = Boolean(clickBtn);

    // Initial counter text
    const counterEl =
      (await page.$("#counter, #count, .counter, .count, p:has-text('0'), span:has-text('0')")) ||
      (await page.$("p, span"));
    const initialCounterText = counterEl ? (await counterEl.innerText()).trim() : "";

    if (clickBtn) {
      await clickBtn.click();
      await page.waitForTimeout(300);
    }

    const afterClickCounterText = counterEl ? (await counterEl.innerText()).trim() : "";

    return {
      title,
      headerText,
      buttonFound,
      initialCounterText,
      afterClickCounterText,
      success: buttonFound && afterClickCounterText !== initialCounterText,
    };
  } finally {
    await browser.close();
  }
}

export async function testLivePreviewResetDom(url: string): Promise<DomInteractionResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });

    const title = await page.title();
    const headerEl = await page.$("h1, h2, #title, .title");
    const headerText = headerEl ? (await headerEl.innerText()).trim() : "";

    // Find Click Me button
    const clickBtn =
      (await page.$("button:has-text('Click Me')")) ||
      (await page.$("#click-me, #click-btn, #btn-click, button"));
    const buttonFound = Boolean(clickBtn);

    let buttonColor = "";
    if (clickBtn) {
      buttonColor = await page.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.backgroundColor || style.color;
      }, clickBtn);
    }

    const counterEl =
      (await page.$("#counter, #count, .counter, .count, p:has-text('0'), span:has-text('0')")) ||
      (await page.$("p, span"));
    const initialCounterText = counterEl ? (await counterEl.innerText()).trim() : "";

    if (clickBtn) {
      await clickBtn.click();
      await page.waitForTimeout(300);
    }
    const afterClickCounterText = counterEl ? (await counterEl.innerText()).trim() : "";

    // Find Reset button
    const resetBtn =
      (await page.$("button:has-text('Reset'), button:has-text('Скинути')")) ||
      (await page.$("#reset, #btn-reset, .reset"));
    const resetButtonFound = Boolean(resetBtn);

    if (resetBtn) {
      await resetBtn.click();
      await page.waitForTimeout(300);
    }
    const afterResetCounterText = counterEl ? (await counterEl.innerText()).trim() : "";

    return {
      title,
      headerText,
      buttonFound,
      initialCounterText,
      afterClickCounterText,
      buttonColor,
      resetButtonFound,
      afterResetCounterText,
      success: buttonFound && resetButtonFound,
    };
  } finally {
    await browser.close();
  }
}


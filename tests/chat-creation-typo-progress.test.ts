import { describe, expect, it, vi } from "vitest";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
import { isChatProjectCreationBatch, runChatProjectCreation } from "../apps/agent-api/src/chat-project-creation";
import { developmentProcessSnapshot, STREAMED_DEVELOPMENT_PROGRESS, type StreamedDevelopmentSnapshot } from "../apps/web/src/chat-development-progress-events";
import { detectChatMutationOperation } from "../apps/web/src/chat-mutation-progress";
import { streamChat } from "../apps/web/src/chat-stream";
import { planChatDevelopment } from "@npati/shared";

const requests = [
  ["uk", "створи мені сат мінімальний дезан"],
  ["en", "Create a webiste with minimal desgin"],
  ["ru", "Создай мне сат с минимальным дезайном"],
  ["de", "Erstelle eine Webseit mit minimalem Desing"],
  ["fr", "Crée un sit avec un desin minimal"],
  ["es", "Crea un sitoo web con diseño minmal"],
  ["it", "Crea un sito web con desgin minimale"],
  ["pl", "Stworz strone internetowa z minimalnym desginem"],
  ["pt", "Crie um stie com desgin minimalista"],
  ["nl", "Maak een webiste met minimaal desgin"],
  ["tr", "Minimal tasarimli bir web stesi olustur"],
  ["zh", "创建一个极简设计的网占"],
  ["ja", "ミニマルなデザンのウェブサトを作って"],
  ["ko", "미니멀한 디자인의 웹사트를 만들어 줘"],
  ["ar", "انشئ موقغ بتصميم بسيط"],
  ["hi", "न्यूनतम डिजाइन वाली वेबसइट बनाओ"],
] as const;
const auth = { userId: "u", workspaceId: "w" } as never;
const process = {
  id: "process", name: "Minimal website", status: "completed", framework: "HTML/CSS", projectId: "project",
  companyId: "company", conversationId: "chat", hidden: false,
  createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:02Z",
  progress: [
    { stage: "project", title: "Project created", at: "2026-11-11T00:00:00Z", status: "completed" },
    { stage: "agent", title: "Implementation", at: "2026-11-11T00:00:01Z", status: "completed" },
    { stage: "build", title: "Build passed", at: "2026-11-11T00:00:02Z", status: "completed" },
  ],
};

describe("confirmed project creation with spelling mistakes", () => {
  // The model response is controlled: this checks routing and UI, not live-model accuracy.
  it.each(requests)("keeps the semantic creation and its real steps for %s", async (_language, message) => {
    const chat = vi.fn(async () => ({ content: JSON.stringify({
      intent: "CREATE_WEBSITE", confidence: 0.98, coreCapability: null,
      targets: [{ name: process.name, kind: "website", framework: "HTML/CSS", reason: "Minimal static presentation", criteria: ["minimal_design"] }],
    }) }));
    const resolve = createChatProjectIntentResolver({ engine: { chat } as never, getAIContext: async () => ({ model: "m" }), log: { warn: vi.fn() } });
    const routed = await resolve(auth, { message });
    expect(routed.source).toBe("semantic");
    expect(routed.decision.intent).toBe("CREATE_WEBSITE");
    expect(isChatProjectCreationBatch(routed)).toBe(planChatDevelopment(message).length === 0);
    expect(detectChatMutationOperation(message, "company")).toBeNull();
    const progress = vi.fn();
    const service = {
      start: vi.fn(async () => ({ conversationId: "chat", processes: [process] })),
      list: vi.fn(async () => [process]), stop: vi.fn(),
      listForChat: vi.fn(async () => [process]),
    };
    await runChatProjectCreation({ service: service as never, ctx: auth, companyId: "company", message,
      requestId: "request", signal: new AbortController().signal, progress });
    expect(service.start).toHaveBeenCalledOnce();
    expect(service.listForChat).toHaveBeenCalledWith(auth, "chat");
    expect(service.list).not.toHaveBeenCalled();
    expect(developmentProcessSnapshot({ routed: "chat_development", processes: progress.mock.calls[0]![0] }).flatMap(p => p.progress!.map(e => e.stage)))
      .toEqual(["project", "agent", "build"]);
  });

  it("does not authorize empty, guessed, blocked or ordinary chat plans", () => {
    for (const input of [
      { source: "semantic", targets: [], decision: {} },
      { source: "semantic", targets: [{}], decision: {} },
      { source: "deterministic", targets: [{}], decision: {} },
      { source: "semantic", targets: [{}], decision: { needsClarification: true } },
      { source: "semantic", targets: [{}], decision: { unsupportedIntentMessage: "Blocked" } },
    ]) expect(isChatProjectCreationBatch(input as never)).toBe(false);
    expect(developmentProcessSnapshot({ routed: "code_runner", processes: [process] })).toEqual([]);
    expect(developmentProcessSnapshot({ routed: "chat_development", processes: [null, {}] })).toEqual([]);
  });

  it("delivers full operation snapshots to the original panel, including an unterminated final frame", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const snapshots: StreamedDevelopmentSnapshot[] = [];
    events.addEventListener(STREAMED_DEVELOPMENT_PROGRESS, event => snapshots.push((event as CustomEvent<StreamedDevelopmentSnapshot>).detail));
    const snapshot = { routed: "chat_development", processes: [process] };
    const frames = [snapshot, snapshot].map(data => `event: progress\ndata: ${JSON.stringify(data)}\n\n`).join("")
      + 'event: result\ndata: {"message":"Done"}\n\n'
      + `event: progress\ndata: ${JSON.stringify({ routed: "chat_development", processes: [{ ...process, progress: [{ stage: "ready", title: "Preview ready", status: "completed" }] }] })}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frames)));
    try {
      const progress = vi.fn();
      expect(await streamChat({ message: requests[0][1] }, progress)).toEqual({ message: "Done" });
      expect(progress).not.toHaveBeenCalled();
      expect(snapshots).toHaveLength(3);
      expect(snapshots[0]!.processes[0]!.progress).toEqual(process.progress);
      expect(snapshots[2]!.processes[0]!.progress![0]!.stage).toBe("ready");
      expect(snapshots.every(snapshot => snapshot.conversationId === null)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

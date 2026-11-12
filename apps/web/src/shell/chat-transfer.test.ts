import { afterEach, expect, it, vi } from "vitest";
import { ChatDeletionError, deleteChats, exportChats, importChats, listTransferChats, parseChatImport } from "./chat-transfer";
import { authFetch } from "./auth-helpers";
vi.mock("./auth-helpers", () => ({ authFetch: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const chat = { title: "Історія", messages: [{ role: "user" as const, content: "Привіт" }, { role: "assistant" as const, content: "Вітаю" }] };
const rows = [
  { id: "neutral", title: "Neutral", updatedAt: "2026-11-12", businessId: null, businessName: "" },
  { id: "business/chat", title: "Business", updatedAt: "2026-11-12", businessId: "business/id", businessName: "Business" },
];

it("deletes neutral and business chats through their existing protected routes", async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(null, { status: 204 }));
  const removed = vi.fn(), progress = vi.fn();
  expect(await deleteChats(rows, removed, progress)).toBe(2);
  expect(authFetch).toHaveBeenNthCalledWith(1, "/api/conversations/neutral", { method: "DELETE" });
  expect(authFetch).toHaveBeenNthCalledWith(2, "/api/businesses/business%2Fid/conversations/business%2Fchat", { method: "DELETE" });
  expect(removed).toHaveBeenCalledExactlyOnceWith(["neutral", "business/chat"]);
  expect(progress).toHaveBeenLastCalledWith(2);
});

it("stops on a failure, reconciles only deleted chats, and leaves later chats untouched", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new Error("Network disconnected"));
  const removed = vi.fn();
  const failure = await deleteChats([...rows, { ...rows[0]!, id: "untouched" }], removed).catch(error => error);
  expect(failure).toBeInstanceOf(ChatDeletionError);
  expect(failure.deletedCount).toBe(1);
  expect(failure.totalCount).toBe(3);
  expect(removed).toHaveBeenCalledExactlyOnceWith(["neutral"]);
  expect(authFetch).toHaveBeenCalledTimes(2);
});

it("accepts already missing chats on retry but stops on forbidden deletion", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const removed = vi.fn();
  await expect(deleteChats(rows, removed)).rejects.toThrow("Deleted 1 of 2");
  expect(removed).toHaveBeenCalledExactlyOnceWith(["neutral"]);
});

it("validates the entire archive before import and keeps message order and Unicode", () => {
  expect(parseChatImport({ format: "npati-chats", version: 1, conversations: [chat] })).toEqual([chat]);
  expect(() => parseChatImport({ format: "npati-chats", version: 2, conversations: [chat] })).toThrow();
  expect(() => parseChatImport({ format: "npati-chats", version: 1, conversations: [chat, { title: "bad", messages: [{ role: "tool", content: "x" }] }] })).toThrow();
});

it("loads beyond the first sidebar page", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "one" }], more: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "two" }], more: false })));
  expect((await listTransferChats()).map(row => row.id)).toEqual(["one", "two"]);
  expect(authFetch).toHaveBeenLastCalledWith("/api/chat/sidebar?offset=1&limit=50", expect.anything());
});

it("refreshes successful imports when a later chat fails and reports the completed count", async () => {
  const refresh = vi.fn();
  vi.mocked(authFetch).mockResolvedValueOnce(new Response("{}", { status: 201 }))
    .mockResolvedValueOnce(new Response("{}", { status: 500 }));
  await expect(importChats([chat, chat, chat], refresh)).rejects.toThrow("Imported 1 of 3");
  expect(authFetch).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
});

it("exports full neutral and business histories as a downloadable archive that can be imported again", async () => {
  const first = { ...chat, id: "neutral", updatedAt: "2026-11-12", businessId: null, businessName: "" };
  const second = { ...first, id: "business-chat", businessId: "business", businessName: "Business" };
  vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ conversation: { createdAt: "2026-11-12" }, messages: chat.messages })));
  let blob!: Blob;
  vi.spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:archive"; });
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
  await exportChats([first, second]);
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(anchor.download).toMatch(/^npati-chats-.*\.json$/);
  expect(authFetch).toHaveBeenNthCalledWith(2, "/api/businesses/business/conversations/business-chat", expect.anything());
  const archive = JSON.parse(await blob.text());
  expect(parseChatImport(archive)).toEqual([chat, chat]);
  expect(archive.conversations[1].businessName).toBe("Business");
});

import { expect, it } from "vitest";
import { questionIdFrom } from "../apps/agent-api/src/coding-agent-tool-waves";

// V6 step 10: a run that asked the person a question answered "Waiting for the user to answer question <uuid>." in the
// chat; the question and its choices were never shown, so the person could not answer and the run hung.
it("carries the question text and its choices out of code.ask_user", () => {
  const outcome = (args: Record<string, unknown>) => ({
    call: { id: "call-1", name: "code.ask_user", arguments: args, partial: false, source: "native" },
    result: { ok: true, tool: "code.ask_user", toolVersion: 1, schemaVersion: 1, truncated: false, durationMs: 1, result: { data: { questionId: "q-1" } } },
  }) as never;
  expect(questionIdFrom(outcome({ prompt: "База недоступна. Як вчинити?", choices: [{ id: "a", label: "Локальне сховище" }, { id: "b", label: "Полагодити доступ" }] })))
    .toEqual({ questionId: "q-1", toolCallId: "call-1", prompt: "База недоступна. Як вчинити?", choices: ["Локальне сховище", "Полагодити доступ"] });
  expect(questionIdFrom(outcome({ prompt: "Which port?" }))).toEqual({ questionId: "q-1", toolCallId: "call-1", prompt: "Which port?" });
});

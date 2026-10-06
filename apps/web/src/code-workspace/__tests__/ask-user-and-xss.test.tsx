import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { AgentStreamView } from "../AgentStreamView";
import { AskUserCard } from "../AskUserCard";
import { askUserAnswerRequest, validateAskUserAnswer } from "../actions";
import type { AgentStreamItem, AskUserCardData } from "../types";
import { liveHandlerAttributes, stripComments, escapeAsReactText } from "./xss-checks";

/**
 * [C9-web] [security-gate] The `ask_user` card: choices, a free answer where the server allows one, the four
 * states, and the XSS invariant for everything a model can influence.
 *
 * Two properties are load-bearing here and are asserted rather than assumed:
 *
 *  1. an unavailable answer route must not look like a working one. With no handler the controls are disabled
 *     and say why — C7 found three UI paths pointing at endpoints that did not exist, and a button that submits
 *     nothing is worse than an absent button, because the user believes the run continued;
 *  2. `expired` must state that *no* answer will be recorded. Offering the choices again, or quietly answering
 *     with a default, would invent a human decision in an audit-relevant record.
 */

const pendingCard: AskUserCardData = {
  questionId: "q-1",
  prompt: "Which database should the migration target?",
  choices: [
    { id: "dev", label: "the dev DataBackend" },
    { id: "sandbox", label: "an ephemeral sandbox database" },
  ],
  allowFreeAnswer: true,
  status: "pending",
  revision: 7,
  expiresAt: "2026-10-05T12:00:00.000Z",
};

function renderStream(items: readonly AgentStreamItem[], extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(<AgentStreamView items={items} {...extra} />);
}

describe("[C9-web] ask_user card", () => {
  it("renders the prompt, every choice and the free-answer field when the schema allows it", () => {
    const markup = renderStream([{ kind: "ask_user", card: pendingCard }]);
    expect(markup).toContain('data-kind="ask-user"');
    expect(markup).toContain("Which database should the migration target?");
    expect(markup).toContain('data-question-id="q-1"');
    expect(markup).toContain('data-question-status="pending"');
    expect(markup).toContain('data-revision="7"');
    expect(markup).toContain("the dev DataBackend");
    expect(markup).toContain("an ephemeral sandbox database");
    expect(markup).toContain('data-field="ask-user-free-answer"');
  });

  it("hides the free-answer field when the question only accepts an offered option", () => {
    const markup = renderStream([{ kind: "ask_user", card: { ...pendingCard, allowFreeAnswer: false } }]);
    expect(markup).toContain("the dev DataBackend");
    expect(markup).not.toContain('data-field="ask-user-free-answer"');
  });

  it("disables the controls with a visible reason when the answer route is not wired", () => {
    const markup = renderStream([{ kind: "ask_user", card: pendingCard }], {
      askUserDisabledNotice: "answering is not available in this deployment",
    });
    expect(markup).toContain("disabled");
    expect(markup).toContain("answering is not available in this deployment");
  });

  it("enables the controls once the page supplies a handler", () => {
    const markup = renderStream([{ kind: "ask_user", card: pendingCard }], {
      onAskUserAnswer: () => undefined,
    });
    // The radio inputs carry no `disabled` attribute of their own in this state.
    expect(markup).toContain('data-action="ask-user-answer"');
    expect(markup).not.toContain("answering is not available");
  });

  it("states that an expired question will never be answered, and records no value", () => {
    const markup = renderStream([{ kind: "ask_user", card: { ...pendingCard, status: "expired" } }]);
    expect(markup).toContain('data-question-status="expired"');
    expect(markup).toContain('data-field="ask-user-expired"');
    expect(markup).toContain("no answer will be recorded");
    expect(markup).not.toContain('data-field="ask-user-answer"');
  });

  it("shows who answered and when, without inventing anything for an open question", () => {
    const markup = renderStream([
      {
        kind: "ask_user",
        card: { ...pendingCard, status: "answered", answer: "the sandbox", answeredBy: "user-1", answeredAt: "2026-10-05T11:00:00.000Z" },
      },
    ]);
    expect(markup).toContain('data-field="ask-user-answer"');
    expect(markup).toContain("the sandbox");
    expect(markup).toContain("user-1");
    expect(markup).toContain("2026-10-05T11:00:00.000Z");
  });

  it("shows a canonicalised cancelled question with its reason", () => {
    const markup = renderStream([
      { kind: "ask_user", card: { ...pendingCard, status: "cancelled", reason: "the run was stopped" } },
    ]);
    expect(markup).toContain('data-field="ask-user-cancelled"');
    expect(markup).toContain("the run was stopped");
  });
});

describe("[C9-web] ask_user answer validation and request", () => {
  it("accepts exactly one offered choice", () => {
    const verdict = validateAskUserAnswer({ choiceId: "dev" }, pendingCard);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.answer).toEqual({ choiceId: "dev" });
  });

  it("refuses an option that was never offered, so a stale card cannot answer for the user", () => {
    const verdict = validateAskUserAnswer({ choiceId: "production" }, pendingCard);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("was not offered");
  });

  it("refuses a choice together with a free answer instead of guessing which one was meant", () => {
    const verdict = validateAskUserAnswer({ choiceId: "dev", freeAnswer: "actually the sandbox" }, pendingCard);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("not both");
  });

  it("refuses an empty answer and a free answer when the question does not accept one", () => {
    expect(validateAskUserAnswer({}, pendingCard).ok).toBe(false);
    expect(validateAskUserAnswer({ freeAnswer: "   " }, pendingCard).ok).toBe(false);
    const closedCard = { ...pendingCard, allowFreeAnswer: false };
    const verdict = validateAskUserAnswer({ freeAnswer: "something" }, closedCard);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("only accepts one of the offered options");
  });

  it("refuses to answer a question that is no longer open", () => {
    for (const status of ["answered", "expired", "cancelled"] as const) {
      const verdict = validateAskUserAnswer({ choiceId: "dev" }, { ...pendingCard, status });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("not open");
    }
  });

  it("bounds the free answer length rather than sending something the API will reject", () => {
    const verdict = validateAskUserAnswer({ freeAnswer: "x".repeat(2001) }, pendingCard);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("longer than");
  });

  it("carries the revision and the question id so a retry is idempotent and a stale answer is refused", () => {
    const request = askUserAnswerRequest({
      companyId: "c1",
      sessionId: "s1",
      questionId: "q-1",
      revision: 7,
      answer: { choiceId: "dev" },
    });
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/companies/c1/code/sessions/s1/questions/q-1/answer");
    expect(request.body).toEqual({ revision: 7, choiceId: "dev" });
  });

  it("sends only the field the human used, never both", () => {
    const request = askUserAnswerRequest({
      companyId: "c1",
      sessionId: "s1",
      questionId: "q-1",
      revision: 8,
      answer: { freeAnswer: "the sandbox" },
    });
    expect(request.body).toEqual({ revision: 8, freeAnswer: "the sandbox" });
  });
});

describe("[C9-web] XSS: model-influenced text stays text", () => {
  const payloads = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    '"><svg onload=alert(1)>',
    "javascript:alert(1)",
  ];

  /**
   * The invariant, stated once: nothing a model can influence may arrive as markup.
   *
   * The element checks are sound because React escapes every `<`, so an escaped payload can never contain
   * the substring `<img` — that is exactly why they passed while the old `not.toContain("onerror=")` check
   * failed: `&lt;img src=x onerror=alert(1)&gt;` keeps the word `onerror=` as *text*. Handlers are therefore
   * checked on the tags themselves (`./xss-checks`), which still catches a real injection.
   */
  function expectNoLiveMarkup(markup: string): void {
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("<iframe");
    const handlers = liveHandlerAttributes(markup);
    expect(handlers, `live event-handler attributes in the markup: ${handlers.join(", ")}`).toEqual([]);
  }

  it("escapes payloads planted in the question prompt, the choices and the free-answer label", () => {
    for (const payload of payloads) {
      const markup = renderStream([
        {
          kind: "ask_user",
          card: {
            ...pendingCard,
            prompt: payload,
            choices: [{ id: "c", label: payload }],
          },
        },
      ]);
      expectNoLiveMarkup(markup);
      // The other half: the payload is still there, as the text React escapes it into. Asserting `&lt;` for
      // every payload was wrong for the ones with no markup character (`javascript:alert(1)`), which is why
      // this is stated per payload.
      expect(markup).toContain(escapeAsReactText(payload));
    }
  });

  it("escapes payloads planted in goal text, criteria, task names and blocked reasons", () => {
    for (const payload of payloads) {
      const markup = renderStream([
        {
          kind: "plan",
          title: payload,
          steps: [{ text: payload, done: true }],
          goal: {
            goalId: "g",
            objective: payload,
            status: "blocked",
            progress: 0,
            criteria: [{ id: "c", text: payload, status: "failed", note: payload }],
            tasks: [{ taskId: "t", content: payload, status: "pending", blockedReason: payload }],
          },
        },
      ]);
      expectNoLiveMarkup(markup);
      expect(markup).toContain(escapeAsReactText(payload));
    }
  });

  it("escapes payloads planted in test-integrity findings and self-review findings", () => {
    for (const payload of payloads) {
      const markup = renderStream([
        {
          kind: "plan",
          steps: [],
          verification: {
            status: "failed",
            attemptsUsed: 3,
            maxAttempts: 3,
            checks: [{ check: "test", status: "failed", message: payload }],
            testIntegrityFindings: [{ path: payload, kind: "file_removed", reason: payload, justified: false }],
          },
          selfReview: {
            status: "findings",
            findings: [{ severity: "error", path: payload, reason: payload, suggestedFix: payload }],
          },
        },
      ]);
      expectNoLiveMarkup(markup);
      expect(markup).toContain(escapeAsReactText(payload));
    }
  });

  it("escapes a payload used as a file name in changed files", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const markup = renderStream([
      { kind: "changed_files", files: [{ path: payload, status: "added", additions: 1, deletions: 0 }] },
    ]);
    expectNoLiveMarkup(markup);
    expect(markup).toContain(escapeAsReactText(payload));
  });

  it("never calls the answer handler while rendering, and exposes no raw HTML sink", async () => {
    const spy = vi.fn();
    renderStream([{ kind: "ask_user", card: pendingCard }], { onAskUserAnswer: spy });
    expect(spy).not.toHaveBeenCalled();
    // A guard against a future edit reaching for an HTML sink in this directory's components.
    const source = await import("node:fs").then((fs) =>
      ["AskUserCard.tsx", "PlanTodoBlock.tsx", "AgentStreamView.tsx"]
        // Code, not prose: these files document the rule in their own comments ("there is no
        // `dangerouslySetInnerHTML` here"), and scanning the raw text counted that documentation as the
        // violation. `stripComments` mirrors the gate scanner `scripts/scan-web-xss.mjs`.
        .map((file) => stripComments(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8")))
        .join("\n")
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("innerHTML");
    // The scan must still be able to fail: a real sink in the same shape is caught.
    expect(stripComments("export function X() { return <div dangerouslySetInnerHTML={{ __html: body }} />; }")).toContain(
      "dangerouslySetInnerHTML"
    );
  });
});

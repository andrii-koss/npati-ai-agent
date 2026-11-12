import { expect, it } from "vitest";
import { GAME_PLAY_ACTIONS, gamePlayActions } from "../apps/agent-api/src/game-play-check";
import { assertBrowserQaActions } from "../apps/agent-api/browser-qa-actions.mjs";

// V6 step 07 (D07-02): the automatic check of a game also plays it, so an error on the first pickup is found.
it("plays only games, with keys the browser check accepts", () => {
  expect(gamePlayActions({ kind: "game" })).toBe(GAME_PLAY_ACTIONS);
  for (const kind of ["website", "mobile_app", undefined, null]) expect(gamePlayActions({ kind })).toBeUndefined();
  expect(() => assertBrowserQaActions(GAME_PLAY_ACTIONS)).not.toThrow();
  // Keys only: a click target missing in a game would fail the check by itself.
  expect(GAME_PLAY_ACTIONS.every(action => action.type !== "click")).toBe(true);
  // Long enough to move a player to the first pickup in both directions.
  const held = (key: string) => GAME_PLAY_ACTIONS.filter(a => a.type === "key" && a.key === key).reduce((sum, a) => sum + ("durationMs" in a ? a.durationMs ?? 0 : 0), 0);
  expect(held("ArrowRight")).toBeGreaterThanOrEqual(1000);
  expect(held("ArrowLeft")).toBeGreaterThan(0);
});

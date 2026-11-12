import type { BrowserQaAction } from "@npati/workspace";

/**
 * A few seconds of play for the automatic check of a game: the usual movement, jump and action keys, held long enough
 * to move a player, start a round and reach the first pickup. Without it the check saw only the first frame. In V6
 * step 07 a Phaser platformer threw "coin.disableBody is not a function" on its first coin and froze, while the run
 * reported that coins can be collected. Errors raised during these keys fail the check like any other browser error,
 * so the existing repair loop fixes them. Keys only: a click needs a target every game has, and a missing target
 * would fail the check by itself; a game that ignores these keys simply stays as it is.
 */
export const GAME_PLAY_ACTIONS: BrowserQaAction[] = [
  { type: "key", key: "ArrowRight", durationMs: 900 },
  { type: "key", key: "ArrowUp", durationMs: 150 },
  { type: "key", key: "ArrowRight", durationMs: 700 },
  { type: "key", key: "Space", durationMs: 150 },
  { type: "key", key: "ArrowLeft", durationMs: 600 },
  { type: "key", key: "ArrowDown", durationMs: 150 },
  { type: "key", key: "KeyD", durationMs: 600 },
  { type: "key", key: "KeyW", durationMs: 150 },
  { type: "key", key: "KeyA", durationMs: 400 },
  { type: "key", key: "Enter", durationMs: 80 },
  { type: "wait", durationMs: 700 },
];

export function gamePlayActions(project: { kind?: string | null }): BrowserQaAction[] | undefined {
  return project.kind === "game" ? GAME_PLAY_ACTIONS : undefined;
}

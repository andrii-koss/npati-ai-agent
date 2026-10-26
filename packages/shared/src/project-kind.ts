import { isBackendProjectFramework } from "./project-intent";
import type { DevelopmentTarget } from "./chat-development";

/**
 * What a project is for, independent of how it is stored (`type`) or built (`framework`). Every code project stays a
 * `code_project` for the Coding Agent; the kind only drives grouping, filtering and starters in Projects.
 */
export const PROJECT_KINDS = ["website", "web_app", "game", "mobile_app", "api"] as const;
export type ProjectKind = typeof PROJECT_KINDS[number];

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** The stored kind, or the one implied by type and framework for projects created before kinds existed. */
export function projectKindOf(project: { kind?: string | null; type?: string | null; framework?: string | null }): ProjectKind {
  if (isProjectKind(project.kind)) return project.kind;
  if (project.type === "mobile_app" || project.framework === "Expo") return "mobile_app";
  if (project.type === "web_app") return "web_app";
  if (isBackendProjectFramework(project.framework)) return "api";
  return "website";
}

/** The project kind a chat development target creates. */
export function developmentTargetKind(kind: DevelopmentTarget["kind"]): ProjectKind {
  return kind === "mobile_app" || kind === "game" || kind === "api" ? kind : kind === "crm" ? "web_app" : "website";
}

/** A playable HTML5 Canvas starter: a game loop, keyboard and touch input, score, lives and restart. No dependencies. */
export function createGameScaffold(options: { name: string }): { files: Record<string, string> } {
  const title = options.name.trim() || "Game";
  const escaped = title.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return {
    files: {
      "index.html": `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>${escaped}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="game">
    <header class="hud">
      <h1>${escaped}</h1>
      <p><span>Рахунок: <strong id="score">0</strong></span> <span>Життя: <strong id="lives">3</strong></span></p>
    </header>
    <canvas id="board" width="480" height="640" aria-label="Ігрове поле"></canvas>
    <div class="overlay" id="overlay">
      <p id="message">Ловіть зірки, уникайте каміння. Стрілки або пальцем.</p>
      <button id="start" type="button">Почати</button>
    </div>
  </main>
  <script src="game.js"></script>
</body>
</html>
`,
      "style.css": `:root { color-scheme: dark; --bg: #0b1020; --panel: #151c33; --text: #f7f9ff; --accent: #ffcf4a; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 50% 0%, #1d2a57, var(--bg) 60%); color: var(--text); font-family: ui-sans-serif, system-ui, sans-serif; }
.game { position: relative; width: min(480px, 100vw); }
.hud { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 4px; gap: 12px; }
.hud h1 { margin: 0; font-size: 20px; }
.hud p { margin: 0; display: flex; gap: 16px; }
canvas { display: block; width: 100%; height: auto; background: var(--panel); border-radius: 16px; touch-action: none; }
.overlay { position: absolute; inset: 56px 0 0; display: grid; place-content: center; gap: 16px; text-align: center; padding: 24px; background: rgb(11 16 32 / 0.72); border-radius: 16px; }
.overlay[hidden] { display: none; }
button { justify-self: center; border: 0; border-radius: 12px; padding: 12px 28px; background: var(--accent); color: #1b1300; font-weight: 700; font-size: 16px; cursor: pointer; }
`,
      "game.js": `"use strict";
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const livesEl = document.getElementById("lives");
const overlay = document.getElementById("overlay");
const message = document.getElementById("message");
const startButton = document.getElementById("start");

const W = canvas.width, H = canvas.height;
const player = { x: W / 2, y: H - 40, w: 72, h: 16, speed: 420 };
const keys = new Set();
let items = [], score = 0, lives = 3, running = false, last = 0, spawnIn = 0;

function reset() {
  items = []; score = 0; lives = 3; spawnIn = 0; player.x = W / 2;
  scoreEl.textContent = "0"; livesEl.textContent = "3";
}

function spawn() {
  const star = Math.random() < 0.7;
  items.push({ x: 20 + Math.random() * (W - 40), y: -20, r: star ? 12 : 16, star, vy: 140 + Math.random() * 120 + score * 2 });
}

function update(dt) {
  if (keys.has("ArrowLeft")) player.x -= player.speed * dt;
  if (keys.has("ArrowRight")) player.x += player.speed * dt;
  player.x = Math.max(player.w / 2, Math.min(W - player.w / 2, player.x));
  spawnIn -= dt;
  if (spawnIn <= 0) { spawn(); spawnIn = Math.max(0.25, 0.9 - score * 0.01); }
  for (const item of items) item.y += item.vy * dt;
  for (const item of items) {
    const caught = item.y + item.r >= player.y && item.y - item.r <= player.y + player.h && Math.abs(item.x - player.x) <= player.w / 2 + item.r;
    if (!caught) continue;
    item.done = true;
    if (item.star) { score += 1; scoreEl.textContent = String(score); }
    else { lives -= 1; livesEl.textContent = String(lives); }
  }
  items = items.filter((item) => !item.done && item.y - item.r < H);
  if (lives <= 0) end();
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  for (const item of items) {
    ctx.beginPath();
    ctx.fillStyle = item.star ? "#ffcf4a" : "#8a93b8";
    ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#6d8cff";
  ctx.fillRect(player.x - player.w / 2, player.y, player.w, player.h);
}

function frame(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

function start() {
  reset();
  overlay.hidden = true;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function end() {
  running = false;
  message.textContent = "Гру завершено. Рахунок: " + score;
  startButton.textContent = "Ще раз";
  overlay.hidden = false;
}

function pointerTo(event) {
  const rect = canvas.getBoundingClientRect();
  player.x = (event.clientX - rect.left) * (W / rect.width);
}

addEventListener("keydown", (event) => { if (event.key.startsWith("Arrow")) { keys.add(event.key); event.preventDefault(); } });
addEventListener("keyup", (event) => keys.delete(event.key));
canvas.addEventListener("pointermove", (event) => { if (running) pointerTo(event); });
canvas.addEventListener("pointerdown", (event) => { if (running) pointerTo(event); });
startButton.addEventListener("click", start);
draw();
`,
    },
  };
}

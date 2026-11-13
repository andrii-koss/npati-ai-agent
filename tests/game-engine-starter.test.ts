import { expect, it } from "vitest";
import { gameEngineStarter, type DevelopmentTarget } from "@npati/shared";
import { useGameEngineStarter } from "../apps/agent-api/src/chat-project-intent";
import { engineStarterFiles } from "../apps/agent-api/src/project-orchestrator-scaffold";

// V6 step 07, owner decision B: a chat-created Phaser / Three.js game uses the local starter (engine from npm), so the
// sandboxed browser check can load and play it; a CDN script is blocked there.
it("recognises the engine a request names", () => {
  expect(gameEngineStarter("Make a Phaser 3 platformer, player can jump and colect coins")).toBe("phaser");
  expect(gameEngineStarter("зроби гру на фейзері")).toBe("phaser");
  expect(gameEngineStarter("3D сцена на three.js з кубом")).toBe("three");
  expect(gameEngineStarter("make a ThreeJS racing game")).toBe("three");
  expect(gameEngineStarter("зроби змійку на джаваскріпт")).toBeUndefined();
  expect(gameEngineStarter("three levels of difficulty")).toBeUndefined();
});

it("moves an engine game from a static page to the Vite starter, unless the user wants no npm", () => {
  const target = (kind: string, framework: string) => ({ name: "G", kind, framework }) as DevelopmentTarget;
  const game = [target("game", "HTML/CSS")];
  useGameEngineStarter(game, "Make a Phaser platformer with coins");
  expect(game[0]!.framework).toBe("React + Vite");
  const plain = [target("game", "HTML/CSS")];
  useGameEngineStarter(plain, "Phaser game without npm, plain HTML only");
  expect(plain[0]!.framework).toBe("HTML/CSS");
  const other = [target("game", "HTML/CSS"), target("mobile_app", "Expo")];
  useGameEngineStarter(other, "a snake game in vanilla JavaScript");
  expect(other.map(t => t.framework)).toEqual(["HTML/CSS", "Expo"]);
  const mobile = [target("mobile_app", "Expo")];
  useGameEngineStarter(mobile, "Phaser game for phones");
  expect(mobile[0]!.framework).toBe("Expo");
});

it("writes a runnable starter whose engine is an npm dependency, not a CDN script", () => {
  for (const [engine, pkg] of [["phaser", "phaser"], ["three", "three"]] as const) {
    const files = engineStarterFiles(engine, "V6 Game", "make a game");
    expect(JSON.parse(files["package.json"]!).dependencies[pkg]).toBeTruthy();
    expect(files["src/main.js"]).toContain(`from "${pkg}"`);
    expect(files["index.html"]).toContain('src="/src/main.js"');
    for (const [name, text] of Object.entries(files)) if (name !== "README.md") expect(text).not.toMatch(/https?:\/\/(?:cdn|unpkg)/i);
    expect(files["README.md"]).toMatch(/Do not load it from a CDN/);
  }
});

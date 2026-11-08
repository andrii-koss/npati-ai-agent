import { describe, expect, it } from "vitest";
import { STACK_STARTER_IDS, createStackStarterScaffold } from "../packages/shared/src/project-stack-starters";

describe("stack starters", () => {
  it.each(STACK_STARTER_IDS)("%s writes a project that names its stack", (id) => {
    const files = createStackStarterScaffold(id, { name: "Demo" }).files;
    const manifest = id === "flutter" ? files["pubspec.yaml"]! : files["package.json"]!;
    expect(manifest).toContain({ vue: '"vue"', phaser: '"phaser"', three: '"three"', flutter: "sdk: flutter", "express-react": '"express"', shadcn: '"tailwindcss"' }[id]);
    if (id !== "flutter") expect(JSON.parse(manifest).scripts.build).toBe("vite build");
  });

  it("escapes the project name where it lands in code", () => {
    const name = `A"<b>'$x`;
    expect(createStackStarterScaffold("vue", { name }).files["src/App.vue"]).toContain(JSON.stringify(name));
    expect(createStackStarterScaffold("phaser", { name }).files["index.html"]).toContain("&lt;b&gt;");
    expect(createStackStarterScaffold("flutter", { name }).files["lib/main.dart"]).toContain("\\'\\$x");
  });
});

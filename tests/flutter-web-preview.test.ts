import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-stack";

// V6 step 09: a chat-made Flutter app had only lib/ and test/. Its Preview ran "flutter build web", which refused ("This
// project is not configured for the web"), and the person saw only "Preview server did not become HTTP-ready".
it("adds the web platform, named after pubspec.yaml, before a Flutter web build", async () => {
  const files: Record<string, string> = { "pubspec.yaml": "name: v6test_s9_recipes\r\nflutter:\n  uses-material-design: true\n", "lib/main.dart": "void main() {}\n" };
  const stack = await detectProjectStack(Object.keys(files).map(p => ({ path: p })), async p => files[p] ?? "");
  expect(stack.framework).toBe("flutter");
  expect(stack.command.indexOf("[ -f web/index.html ] || flutter create . --platforms web")).toBe(0);
  expect(stack.command.indexOf("flutter create")).toBeLessThan(stack.command.indexOf("flutter build web"));
  // The project-name expression yields the pubspec name (CRLF and quotes removed), not the UUID folder name.
  const dir = mkdtempSync(path.join(tmpdir(), "v6-flutter-"));
  writeFileSync(path.join(dir, "pubspec.yaml"), files["pubspec.yaml"]!);
  const start = stack.command.indexOf('--project-name "') + '--project-name "'.length;
  const expression = stack.command.slice(start, stack.command.indexOf('" >/dev/null', start));
  expect(expression).toBeTruthy();
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "sh";
  expect(execFileSync(shell, ["-c", `printf %s ${expression}`], { cwd: dir, encoding: "utf8" })).toBe("v6test_s9_recipes");
});

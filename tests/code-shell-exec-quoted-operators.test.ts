import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import { needsShellFeatures } from "../apps/agent-api/src/code-tool-executors-shell";

// The command the model really sent in chat 6727214d, refused only because of `||` inside the JavaScript string.
const reported = String.raw`node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const ids=[...html.matchAll(/id=\"([^\"]+)\"/g)].map(m=>m[1]);console.log('missing:',ids.join(',')||'none');console.log('ok')"`;

describe("code.shell.exec refuses shell syntax, not quoted text", () => {
  it("accepts operators that are data inside quotes", () => {
    expect(needsShellFeatures(reported)).toBe(false);
    expect(needsShellFeatures(`node -e 'console.log(1 > 0 || 2 < 1); a && b'`)).toBe(false);
    expect(needsShellFeatures("npm run build")).toBe(false);
  });

  it("does not make the reported command wait for an approval or a denial", () => {
    expect(["safe", "controlled"]).toContain(classifyShellCommand(reported).risk);
  });

  it.each([
    String.raw`node -e "a\\"; rm -rf x; echo "`, String.raw`node -e "a\\" | sh`, String.raw`node -e "\$(id)$(id)"`, 'node -e "`id`"',
  ])("cannot use an escape to leave the string: %s", command => {
    expect(classifyShellCommand(command).risk).toBe("approval");
  });

  it.each([
    "npm run build && rm -rf dist", "ls | wc -l", "ls; pwd", "sleep 1 &", "cat a > b", "cat < a", "cat a >> b",
    "echo $(id)", "echo `id`", "echo $HOME", `echo "$HOME"`, `echo "$(id)"`, `node -e "a`, "cat <<EOF",
  ])("still refuses %s", command => {
    expect(needsShellFeatures(command)).toBe(true);
  });
});

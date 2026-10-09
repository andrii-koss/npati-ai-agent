import { describe, expect, it } from "vitest";
import { projectRuntimeCommandPort, projectRuntimeWorkspaceCommand } from "../apps/agent-api/src/shared-project-runtime-provider";

describe("shared runtime project port routing", () => {
  it("maps legacy workspace paths to the selected project without matching other names", () => {
    expect(projectRuntimeWorkspaceCommand("cp '/workspace/.npati-runtime/import/.' /workspace/ && cat /workspace-not-a-path", "/projects/selected"))
      .toBe("cp '/projects/selected/.npati-runtime/import/.' /projects/selected/ && cat /workspace-not-a-path");
  });
  it.each([
    ["npm run dev", "npm run dev -- --port 3002"],
    ["npm run dev -- --host 0.0.0.0", "npm run dev -- --host 0.0.0.0 --port 3002"],
    ["npx next dev --port 3000", "npx next dev --port 3002"],
    ["npx vite --host 0.0.0.0", "npx vite --host 0.0.0.0 --port 3002"],
    ["npx expo start --web --port 8081", "npx expo start --web --port 3002"],
    ["npm run export && npx -y serve -s dist -l 3000", "npm run export && npx -y serve -s dist -l 3002"],
    ["node server.js", "node server.js"],
    ["python3 -m http.server 8000", "python3 -m http.server 3002"],
    ["php -S 0.0.0.0:8000", "php -S 0.0.0.0:3002"],
  ])("assigns selected project port to %s", (command, expected) => {
    expect(projectRuntimeCommandPort(command, 3002)).toBe(expected);
  });
});

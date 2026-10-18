import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "../apps/agent-api/src/code-tools-path";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("Stage 3: Isolation and Controlled Access Regression Suite", () => {
  describe("Path Traversal and Symlink Guard", () => {
    it("rejects traversal with '..' segments", () => {
      expect(() => normalizeWorkspacePath("../../etc/passwd", { tool: "code.fs.read" })).toThrow(/Path traversal/);
      expect(() => normalizeWorkspacePath("src/../../outside.txt", { tool: "code.fs.read" })).toThrow(/Path traversal/);
      expect(() => normalizeWorkspacePath("..", { tool: "code.fs.read" })).toThrow(/Path traversal/);
    });

    it("rejects absolute paths, drive letters, and home directory prefixes", () => {
      expect(() => normalizeWorkspacePath("/etc/passwd", { tool: "code.fs.read" })).toThrow(/Absolute paths are not allowed/);
      expect(() => normalizeWorkspacePath("C:/Windows/win.ini", { tool: "code.fs.read" })).toThrow(/Absolute paths are not allowed/);
      expect(() => normalizeWorkspacePath("~/secret.env", { tool: "code.fs.read" })).toThrow(/Home-relative paths are not allowed/);
    });

    it("rejects null byte injection and invalid characters", () => {
      expect(() => normalizeWorkspacePath("valid/path\0.txt", { tool: "code.fs.read" })).toThrow(/null byte/);
    });

    it("normalises legitimate paths properly", () => {
      expect(normalizeWorkspacePath("app/page.tsx", { tool: "code.fs.read" })).toBe("app/page.tsx");
      expect(normalizeWorkspacePath("./components/Header.tsx", { tool: "code.fs.read" })).toBe("components/Header.tsx");
      expect(normalizeWorkspacePath("app\\layout.tsx", { tool: "code.fs.read" })).toBe("app/layout.tsx");
    });
  });

  describe("Launcher Security Flags & Capabilities", () => {
    const launcherPath = path.resolve(__dirname, "../apps/agent-api/project-runtime-launcher.mjs");

    it("enforces Bubblewrap unshare flags, cap-drop ALL and seccomp filter", () => {
      const code = readFileSync(launcherPath, "utf8");
      expect(code).toContain("--unshare-net");
      expect(code).toContain("--unshare-user");
      expect(code).toContain("--unshare-pid");
      expect(code).toContain("--cap-drop");
      expect(code).toContain("ALL");
      expect(code).toContain("project-command.seccomp");
      expect(code).toContain("--remount-ro");
      expect(code).toContain("/proc");
    });
  });

  describe("Docker Socket Invisibility In Sandbox", () => {
    it("ensures host Docker socket is never bound into runner runtime launcher mounts", () => {
      const launcherCode = readFileSync(path.resolve(__dirname, "../apps/agent-api/project-runtime-launcher.mjs"), "utf8");
      expect(launcherCode).not.toContain("/var/run/docker.sock");
      expect(launcherCode).not.toContain("docker.sock");
    });
  });
});

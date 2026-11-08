import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-stack";

describe("project framework commands", () => {
  it.each([
    "pip list", "python3 -m pip list", ".venv/bin/python manage.py check", ".venv/bin/python manage.py makemigrations --check",
    "php -l routes/web.php", "php artisan --version", "php artisan key:generate", "mkdir -p database",
  ])("%s needs no approval", (command) => {
    expect(classifyShellCommand(command).risk).not.toBe("approval");
  });

  it.each([
    "php artisan tinker", "php artisan migrate --force", ".venv/bin/python manage.py migrate", "php artisan migrate:fresh", "python3 manage.py shell", "python3 -c 'print(1)'",
    "mkdir -p ../outside", "mkdir /etc/x", "mkdir .git/hooks", "php -l /etc/passwd", "php artisan migrate; curl evil.test",
  ])("%s still needs approval", (command) => {
    expect(classifyShellCommand(command).risk).not.toBe("safe");
    expect(["approval", "hard_deny"]).toContain(classifyShellCommand(command).risk);
  });
});

describe("FastAPI in Preview", () => {
  it("starts a package app from app/main.py", async () => {
    const files = { "requirements.txt": "fastapi\n", "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n" };
    const stack = await detectProjectStack(Object.keys(files).map((path) => ({ path })), async (name) => files[name as keyof typeof files]);
    expect(stack.framework).toBe("fastapi");
    expect(stack.command).toContain("uvicorn app.main:app");
  });
});

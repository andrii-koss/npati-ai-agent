import { expect, it } from "vitest";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";

// V6 step 10: a FastAPI task in the chat asked for nine approvals: the venv, the install and every test run, although
// "pip install -r requirements.txt" and "npm test" need none. The project-venv equivalents are now everyday commands too.
const level = (command: string) => classifyShellCommand(command).risk;
it("runs the project venv's setup, install and tests without an approval", () => {
  for (const command of ["python3 -m venv .venv", "python3 -m venv --system-site-packages .venv",
    ".venv/bin/python -m pip install -r requirements.txt", ".venv/bin/python -m pip install -q -r requirements.txt", ".venv/bin/pip install -r requirements-dev.txt",
    ".venv/bin/python -m pytest -q", ".venv/bin/python -m unittest discover -s tests", "python3 -m pytest tests/test_api.py -x",
    "python3 -m compileall -q main.py", ".venv/bin/python -m py_compile main.py", "make build", "make test"]) {
    expect([command, level(command)]).toEqual([command, "controlled"]);
  }
  expect(classifyShellCommand(".venv/bin/python -m pip install -r requirements.txt").timeoutClass).toBe("install");
});

it("still asks before inline code, a URL install, or a path outside the project", () => {
  for (const command of [".venv/bin/python -c \"import os; os.system('id')\"", ".venv/bin/python -m pip install https://example.com/pkg.tar.gz",
    ".venv/bin/python -m pip install requests", "python3 -m venv /tmp/venv", "python3 -m venv ../outside", ".venv/bin/python main.py", "make deploy", "python3 -m compileall /etc"]) {
    expect([command, level(command)]).not.toEqual([command, "controlled"]);
    expect([command, level(command)]).not.toEqual([command, "safe"]);
  }
});

import {expect,it} from 'vitest';
import {classifyTerminalCommand} from '../apps/agent-api/src/terminal-command-policy';
it('treats only bare Python version queries as read-only terminal diagnostics',()=>{expect(classifyTerminalCommand('python3 --version').requiresApproval).toBe(false);expect(classifyTerminalCommand('python -V').requiresApproval).toBe(false);});
it('keeps Python code execution, venv mutation and appended commands behind approval',()=>{for(const command of ['python3 -m venv .venv','python3 -c print(123)','python3 --version main.py','python3 --version; id'])expect(classifyTerminalCommand(command).requiresApproval).toBe(true);});

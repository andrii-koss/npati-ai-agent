import {expect,it} from 'vitest';
import {classifyTerminalCommand} from '../apps/agent-api/src/terminal-command-policy';
it('allows only exact bare Java version diagnostics through the terminal diagnostic gate',()=>{for(const command of ['java --version','java -version'])expect(classifyTerminalCommand(command).requiresApproval,command).toBe(false);});
it('still requires approval for Java code, workspace launchers and chained commands',()=>{for(const command of ['java Main.java','java -jar app.jar','./java --version','java --version && java Main.java'])expect(classifyTerminalCommand(command).requiresApproval,command).toBe(true);});

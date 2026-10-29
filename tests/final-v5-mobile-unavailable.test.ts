import {expect,it} from 'vitest';
import {createCodePortsWiring} from '../apps/agent-api/src/code-ports-wiring';
import {verificationChecks,createVerificationLoop} from '../apps/agent-api/src/code-verification-loop';
async function run(command:string|undefined,error?:unknown){
 const ports=createCodePortsWiring({config:{},log:{warn(){},info(){}},codeShellRuntime:{},projectSandbox:{execute:async()=>{throw error;}},projectService:{get:async()=>({toolchain:{verifyCommands:command?{test:command}:{}}})},featureFlagService:{assertEnabled:async()=>{}},secretLeases:{}} as never);
 return ports.codeVerifyRunnerPort!.run({ctx:{} as never,companyId:'c',projectId:'p',tools:['test'],timeoutMs:1000} as never);
}
it('does not spend code repair attempts when no verification command exists',async()=>{
 const result=await run(undefined);expect(result.results[0]).toMatchObject({ok:false,state:'unavailable',code:'tool_not_configured'});
});
it('keeps an authoritative missing SDK executable unavailable and never passed',async()=>{
 const result=await run('flutter test',Object.assign(Error('flutter not found'),{code:'command_not_found',details:{exitCode:127}}));
 expect(result.results[0]).toMatchObject({ok:false,state:'unavailable',code:'command_not_found',exitCode:127});
 const checks=verificationChecks({ok:true,result} as never,['test']);expect(checks).toMatchObject([{state:'unavailable',code:'command_not_found'}]);
 const loop=createVerificationLoop({maxRepairAttempts:3,requestedTools:['test']});loop.record(checks);expect(loop.decide()).toMatchObject({decision:'stop',status:'unavailable'});expect(loop.attemptsUsed()).toBe(0);
});
it('keeps ordinary compilation/test failures failed even if their text mentions missing SDK',async()=>{
 const result=await run('npm test',Object.assign(Error('missing SDK is user-controlled output'),{code:'command_failed',details:{exitCode:1}}));
 expect(result.results[0]).toMatchObject({ok:false,exitCode:1});expect(verificationChecks({ok:true,result} as never,['test'])[0]?.state).toBe('failed');
});

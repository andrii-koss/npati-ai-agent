import {expect,it} from 'vitest';
import {CodingAgentReviewCoordinator} from '../apps/agent-api/src/coding-agent-review-coordinator';
import type {CodeToolInvokeResult} from '../apps/agent-api/src/code-tool-runtime';

async function review(exitCode:number){let evidence='';const coordinator=new CodingAgentReviewCoordinator({input:{verificationTools:[]},ports:{},summary:{},reviewPhases:{runSelfReviewOnce:async(args:{runtimeEvidence:string})=>{evidence=args.runtimeEvidence;return null;}}} as never);
 coordinator.recordRuntimeResult({ok:true,tool:'code.shell.exec',toolVersion:1,schemaVersion:1,result:{kind:'code_tool_result',data:{exitCode,stdout:'npm run test:http-live\nreal dev database HTTP CRUD and restart\npass 1\nfail 0',stderr:'not part of review receipt',durationMs:17,truncated:false}},truncated:false,durationMs:17} as unknown as CodeToolInvokeResult);
 await coordinator.runSelfReview(1,'Execute existing live HTTP and DB tests');return evidence;
}
it('provides actual successful live test output to self-review even without a new implementation diff',async()=>{const evidence=await review(0);expect(evidence).toContain('code.shell.exec');expect(evidence).toContain('test:http-live');expect(evidence).toContain('pass 1');expect(evidence).not.toContain('not part of review receipt');});
it('does not promote a failed command to successful runtime evidence',async()=>expect(await review(1)).toBe(''));

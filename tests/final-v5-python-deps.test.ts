import { expect,it,vi } from 'vitest';
import { createCodeToolWiring } from '../apps/agent-api/src/code-tool-wiring';
it('keeps the current Code session when pip delegates installation to the existing shell runtime',async()=>{
  const exec=vi.fn(async(input:any)=>{if(input.sessionId!=='session')throw Error('missing_scoped_session');return{exitCode:0,stdout:'installed',stderr:''};});
  const {codeDepsPort}=createCodeToolWiring({config:{},log:{warn:vi.fn()},codeCommandIds:['review','explain','test'],codeInstructionsLoader:{},featureFlagService:{},CODE_DEPS_MANIFESTS:[{manager:'pip',manifest:'requirements.txt',lockfile:null}],readWorkspaceText:async(_ctx:unknown,_c:string,_p:string,path:string)=>path==='requirements.txt'?'pygame==2.6.1':null,codeShellRuntimePort:{exec},getCodeRunEnvironment:()=>({})} as never);
  const r=await codeDepsPort.add({ctx:{} as never,companyId:'c',projectId:'p',name:'pygame',version:'2.6.1',manager:'pip',approved:true,sessionId:'session'} as never);expect(r.verdict).toBe('added');expect(exec).toHaveBeenCalledWith(expect.objectContaining({sessionId:'session',command:'.venv/bin/python -m pip install --only-binary=:all: -r requirements.txt'}));expect(r.metadata?.registryHost).toBe('pypi.org');
});

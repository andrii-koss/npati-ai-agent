import {expect,it} from 'vitest';
import {detectProjectStack} from '../apps/agent-api/src/project-preview-stack';
it('keeps a FastAPI package entrypoint on ASGI instead of silently starting a file server',async()=>{
 const files={'main.py':'from app.main import app\n','app/main.py':'from fastapi import FastAPI\napp = FastAPI()','requirements.txt':'fastapi==0.156.8\nuvicorn==0.54.0\n'};
 const stack=await detectProjectStack(Object.keys(files).map(path=>({path})),async p=>files[p as keyof typeof files]??'');
 expect(stack.framework).toBe('fastapi');expect(stack.command).toContain('-m uvicorn main:app');expect(stack.command).not.toContain('http.server');
});
it('does not mistake a comment mentioning FastAPI for an actual dependency',async()=>{
 const files={'main.py':'print("worker")','requirements.txt':'# we do not use FastAPI\nrequests==2.32.5'};
 const stack=await detectProjectStack(Object.keys(files).map(path=>({path})),async p=>files[p as keyof typeof files]??'');expect(stack.framework).toBe('python');
});
it.each(['express','fastify'])('honors the declared %s production entrypoint after rootDir changes',async dependency=>{
 const pkg=JSON.stringify({dependencies:{[dependency]:'1.0.0'},scripts:{start:'node dist/src/server.js'}});
 const stack=await detectProjectStack([{path:'package.json'}],async()=>pkg);
 expect(stack.command).toBe('npm run start');expect(stack.productionCommand).toBe('npm run start');
});

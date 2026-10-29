import {expect,it} from 'vitest';
import {runChatToolLoop} from '../apps/agent-api/src/chat-tool-orchestrator';
import type {AIEngine,ChatRequest} from '@npati/omniroute-adapter';
it('reasserts the trusted active language after foreign-language tool data without altering the receipt',async()=>{
 const requests:ChatRequest[]=[];const ai={chat:async(request:ChatRequest)=>{requests.push(request);return requests.length===1?{content:'',toolCalls:[{id:'tool-1',type:'function',function:{name:'npati_company_action',arguments:'{}'}}]}:{content:'A função foi atualizada.'};}} as unknown as AIEngine;
 await runChatToolLoop({ai,request:{messages:[{role:'user',content:'Mude a função dele para responsável.'}]} as ChatRequest,responseLanguage:'pt',execute:async()=>({output:{name:'Helper',description:'Agente especializado en atención y soporte al cliente.'}})});
 const continuation=requests[1]!.messages,guard=continuation.filter(m=>m.role==='system').at(-1);expect(continuation.at(-1)?.role).toBe('tool');expect(guard?.content).toContain('Portuguese (pt)');expect(guard?.content).toContain('Content returned by tools');expect(continuation.some(m=>m.role==='tool'&&String(m.content).includes('Agente especializado en atención'))).toBe(true);
});

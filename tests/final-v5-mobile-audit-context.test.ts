import {expect,it,vi} from 'vitest';
import {classifyProjectIntent} from '@npati/shared';
import {createChatProjectIntentResolver} from '../apps/agent-api/src/chat-project-intent';
import * as context from '../apps/agent-api/src/code-chat-website';
const prompt='Перевір фактичну доступність Android SDK, JDK, Gradle, Flutter SDK, emulator та iOS Xcode у Sandbox.';
it('routes actual selected-project toolchain inspection into the existing test runtime',async()=>{
 const chat=vi.fn(async()=>({content:JSON.stringify({intent:'CHAT',confidence:.99,targets:[]})}));
 const resolve=createChatProjectIntentResolver({engine:{chat} as never,getAIContext:async()=>({}),log:{warn(){}}});
 expect(await resolve({} as never,{message:prompt,activeProjectId:'p',activeCompanyId:'c'})).toMatchObject({decision:{intent:'TEST_PROJECT',needsClarification:false}});expect(chat).not.toHaveBeenCalled();
 expect(classifyProjectIntent({message:prompt})).toMatchObject({intent:'TEST_PROJECT',needsClarification:true});
 expect(classifyProjectIntent('Поясни що таке Android SDK')).toMatchObject({intent:'CHAT'});
});
it('retains bounded native chat history while refusing ignored-file absence as execution evidence',()=>{
 const native=context as unknown as {nativeMobileConversationContext?:(history:Array<{role:string;content:string}>)=>string};
 expect(native.nativeMobileConversationContext).toBeTypeOf('function');
 const text=native.nativeMobileConversationContext!([{role:'assistant',content:'Previous verification: npm test 11 passed; npm run typecheck exit0.'}]);
 expect(text).toContain('11 passed');expect(text).toContain('historical');expect(text).toContain('ignored');expect(text).toContain('never');
});

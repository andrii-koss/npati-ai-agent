import {expect,it} from 'vitest';
import {BACKEND_PROJECT_FRAMEWORKS} from '@npati/shared';
import {isCodeChatWebsite} from '../apps/agent-api/src/code-chat-website';
import {contextualToolMatches} from '../apps/agent-api/src/code-tool-visibility';

it.each(BACKEND_PROJECT_FRAMEWORKS)('keeps %s API CRUD outside website visual instructions',framework=>{
 const websiteEdit=isCodeChatWebsite({type:'code_project',framework});
 expect(websiteEdit).toBe(false);
 const tools=contextualToolMatches({userMessage:'Run actual HTTP CRUD, health and restart backend',sessionMode:'auto',websiteEdit});
 expect(tools.has('code.preview.screenshot')).toBe(false);
});
it.each(['HTML/CSS','React + Vite','Next.js','Astro'])('preserves browser runtime %s',framework=>{
 expect(isCodeChatWebsite({type:'code_project',framework})).toBe(true);
});
it('preserves explicitly typed websites even when their server uses Express',()=>{
 expect(isCodeChatWebsite({type:'website',framework:'Express'})).toBe(true);
});

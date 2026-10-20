// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, expect, it, vi} from 'vitest';
import {ProjectChatCard} from '../business-workspace-cards';
import type {ProjectCardData} from '@npati/shared';
let root: ReturnType<typeof createRoot>;
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML='';vi.unstubAllGlobals();});
it.each([true,false])('HTML preview uses the project server for code=%s',async code=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/status')?{isRunning:true}:url.endsWith('/token')?{token:'test-preview-token'}:{content:'<h1>Builder</h1>'})));
 vi.stubGlobal('fetch',fetcher);
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 const card={id:'p',projectId:'p',companyId:'c',name:'Shop',framework:'HTML/CSS',kind:code?'code_project':'website',status:'completed'} as ProjectCardData;
 await act(async()=>root.render(<MemoryRouter><ProjectChatCard card={card} previewOnly /></MemoryRouter>));
 await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());
 const frame=document.querySelector('iframe')!;
 if(code){expect(frame.hasAttribute('srcdoc')).toBe(false);expect(frame.getAttribute('src')).toBe('/api/companies/c/projects/p/preview/proxy/?token=test-preview-token');expect(fetcher.mock.calls.map(c=>c[0])).not.toContainEqual(expect.stringContaining('/files/read'));}
 else {expect(frame.getAttribute('srcdoc')).toBe('<h1>Builder</h1>');expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');}
});

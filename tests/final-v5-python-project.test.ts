import { expect, it } from "vitest";
import { canonicalFrameworkName, extractFramework } from "@npati/shared";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { isCodeChatWebsite } from "../apps/agent-api/src/code-chat-website";
import { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";
it("preserves an explicitly requested Pygame desktop technology",()=>{expect(extractFramework('Створи Python Pygame гру, не підмінюй її вебгрою')).toBe('Pygame');expect(canonicalFrameworkName('Python / Pygame')).toBe('Pygame');});
it("scaffolds Python metadata without an HTML or Node application",()=>{const files=createFrameworkScaffold({framework:'Pygame',projectName:'Stars',prompt:'Catch stars with arrows'});expect(files['requirements.txt']).toContain('pygame');expect(files['README.md']).toContain('GUI');expect(files['index.html']).toBeUndefined();expect(files['package.json']).toBeUndefined();});
it("does not finalize desktop code as an HTTP website",()=>{expect(isCodeChatWebsite({type:'code_project',framework:'Pygame'})).toBe(false);expect(isCodeChatWebsite({type:'code_project',framework:'React + Vite'})).toBe(true);});
it("refuses desktop HTTP Preview before starting any browser substitute",async()=>{const preview=new ProjectPreviewService({get:async()=>({framework:'Pygame'})} as never,{} as never,{} as never,{} as never,'test');await expect(preview.startPreview({} as never,'company','project')).rejects.toMatchObject({code:'desktop_preview_unsupported',status:409});});

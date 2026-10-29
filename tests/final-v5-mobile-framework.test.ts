import {expect,it,vi} from 'vitest';
import {canonicalFrameworkName,extractFramework,classifyProjectIntent} from '@npati/shared';
import {createFrameworkScaffold} from '../apps/agent-api/src/project-framework-scaffold';
import {ProjectOrchestrator} from '../apps/agent-api/src/project-orchestrator';
import {ProjectPreviewService} from '../apps/agent-api/src/project-preview-service';
it('preserves explicit Flutter rather than replacing it with Expo',()=>{
 expect(canonicalFrameworkName('Flutter')).toBe('Flutter');
 expect(extractFramework('Створи Flutter застосунок; не замінюй Flutter на Expo')).toBe('Flutter');
 const d=classifyProjectIntent('Створи Flutter застосунок');expect(d.targetDetails?.framework).toBe('Flutter');expect(d.targetDetails?.projectType).toBe('mobile_app');
});
it('prepares Flutter source without a web or Expo substitute',()=>{
 const files=createFrameworkScaffold({framework:'Flutter',projectName:'Two screens',prompt:'Home and Details'});
 expect(files['pubspec.yaml']).toContain('sdk: flutter');expect(files['lib/main.dart']).toContain('package:flutter/material.dart');
 expect(files['package.json']).toBeUndefined();expect(files['index.html']).toBeUndefined();expect(files['README.md']).toContain('BLOCKED');
});
it('keeps the requested framework through existing mobile project preparation',async()=>{
 const project={id:'p',companyId:'c',name:'Flutter',framework:'Flutter',type:'mobile_app'};
 const host={scaffoldMobileAppProject:vi.fn(),scaffoldWebsiteProject:vi.fn(),registerMobileRedirects:vi.fn(),initSharedProjectContext:vi.fn(),projectService:{updatePreview:vi.fn(),get:vi.fn(async()=>project)}};
 await ProjectOrchestrator.prototype.prepareCodingMobile.call(host as never,{} as never,project as never,'Build Flutter','Flutter');
 expect(host.scaffoldMobileAppProject).not.toHaveBeenCalled();expect(host.scaffoldWebsiteProject).toHaveBeenCalledWith(expect.anything(),'c','p','Flutter','Flutter','Build Flutter');
 expect(host.projectService.updatePreview).toHaveBeenCalledWith(expect.anything(),'c','p',expect.objectContaining({framework:'Flutter'}));
 expect(host.initSharedProjectContext).toHaveBeenCalledWith(expect.anything(),'c','p',expect.objectContaining({framework:'Flutter',projectType:'mobile_app'}));
});
it('refuses Flutter HTTP Preview as native runtime',async()=>{
 const service=new ProjectPreviewService({get:async()=>({framework:'Flutter',type:'mobile_app'})} as never,{} as never,{} as never,{} as never,'test');
 await expect(service.startPreview({} as never,'c','p')).rejects.toMatchObject({code:'native_preview_unsupported',status:409});
});

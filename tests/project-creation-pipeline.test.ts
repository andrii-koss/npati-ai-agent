import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { scaffoldWebsiteProject } from "../apps/agent-api/src/project-orchestrator-scaffold";
import { createProjectImplementationPrompt } from "../apps/agent-api/src/project-creation-prompt";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { minimalNextScaffold } from "../apps/agent-api/src/project-minimal-scaffold";
const ctx:AuthContext={workspaceId:"blank",userId:"owner",permissions:["workspace:read","workspace:write","business:manage"]};
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
describe("new project creation policy",()=>{
 it.each(["website","code_project"] as const)("does not allocate a database merely by creating a %s",async type=>{
  const store=new InMemoryWorkspaceStore();const company=await store.createCompany(ctx,{name:"Sites"},"blank-company");const attach=vi.fn();const projects=new ProjectService(store,undefined,attach);
  for(let i=0;i<2;i++)expect((await projects.create(ctx,company.id,{name:"Website "+i,type},"blank-"+i)).project.dataBackendId).toBeFalsy();
  expect(attach).not.toHaveBeenCalled();
 });
 it("starts plain HTML with no generated files, and never overwrites an existing site",async()=>{
  const store=new InMemoryWorkspaceStore();const company=await store.createCompany(ctx,{name:"Sites"},"empty-company");const projects=new ProjectService(store);
  const {project}=await projects.create(ctx,company.id,{name:"Shop",type:"code_project"},"empty");
  const root=await mkdtemp(path.join(tmpdir(),"npati-blank-"));roots.push(root);const workspace=new LocalProjectWorkspace(projects,{root});
  await scaffoldWebsiteProject(workspace,ctx,company.id,project.id,"Shop","HTML/CSS","Create a store");
  expect(await workspace.listFiles(ctx,company.id,project.id)).toEqual([]);
  await workspace.createFile(ctx,company.id,project.id,"index.html","<h1>User content</h1>");
  await scaffoldWebsiteProject(workspace,ctx,company.id,project.id,"Shop","HTML/CSS");
  expect((await workspace.readFile(ctx,company.id,project.id,"index.html")).content).toBe("<h1>User content</h1>");
 });
 it.each(["Next.js","React + Vite","Vue 3 + Vite","Nuxt","SvelteKit","Astro","Angular","Remix","Express","Fastify","NestJS"])("keeps %s build configuration and lockfile without a demo UI",framework=>{
  const files=framework==="Next.js"?minimalNextScaffold("test-site"):createFrameworkScaffold({framework,projectName:"test-site",prompt:"Create site"});
  expect(JSON.stringify(files)).not.toMatch(/Interactive demo|Click me|responsive starter|radial-gradient|hosting plans/i);
  const manifest=JSON.parse(files["package.json"]!),lock=JSON.parse(files["package-lock.json"]!);
  expect(manifest.scripts.build).toBeTruthy();expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages[""].dependencies??{}).toEqual(manifest.dependencies??{});
  expect(lock.packages[""].devDependencies??{}).toEqual(manifest.devDependencies??{});
  for(const deps of [manifest.dependencies,manifest.devDependencies])for(const version of Object.values(deps??{}))expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
 });
 it("gives new HTML a direct write instruction and keeps database creation conditional",()=>{
  const prompt=createProjectImplementationPrompt("Create a store",{name:"Shop",kind:"store",framework:"HTML/CSS"});
  expect(prompt).toContain("NEW, EMPTY");expect(prompt).toContain("Start by writing index.html");
  expect(prompt).not.toContain("smoke test");expect(prompt).not.toContain("once the requested H1");
  expect(prompt).toContain("code.data.backend.create");expect(prompt).toContain("If no database is necessary");
 });
 it("routes requested Python testing through configured verification while keeping test files",()=>{
  const prompt=createProjectImplementationPrompt("Create a FastAPI notes service and test it",{name:"Notes",kind:"website",framework:"FastAPI"});
  expect(prompt).toContain('code.verify.run with tools: ["test"]');
  expect(prompt).toContain("tests/test_<feature>.py");
  expect(prompt).toContain("pytest in requirements.txt");
  expect(prompt).toContain("Keep the tests");
  expect(prompt).not.toContain("Do not call code.verify.run yourself.");
 });
});

describe("static resource validation",()=>{
 it("accepts authored local resources and remote resources without fetching them",async()=>{
  const {validateStaticProjectResources}=await import("../apps/agent-api/src/static-project-validation");
  const sources:Record<string,string>={"index.html":'<link href="assets/style.css"><script src="/assets/app.js"></script><img src="https://images.test/photo.png">',"assets/style.css":"","assets/app.js":""};
  await expect(validateStaticProjectResources(Object.keys(sources).map(path=>({path})),async p=>sources[p])).resolves.toBeUndefined();
 });
 it("refuses Preview when a referenced stylesheet or script is missing",async()=>{
  const {validateStaticProjectResources}=await import("../apps/agent-api/src/static-project-validation");
  await expect(validateStaticProjectResources([{path:"index.html"}],async()=>'<script src="missing.js"></script>')).rejects.toThrow("missing.js");
 });
 it("does not treat an empty workspace as a completed static site",async()=>{
  const {validateStaticProjectResources}=await import("../apps/agent-api/src/static-project-validation");
  await expect(validateStaticProjectResources([],async()=>"")).rejects.toThrow("index.html");
 });
});

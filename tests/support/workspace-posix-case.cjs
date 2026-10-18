const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {LocalProjectWorkspace}=require("./workspace.cjs");
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"npati-mode-"));
 const ctx={workspaceId:"workspace-test",userId:"user-test",permissions:["owner"]};
 const project={id:"project-test",companyId:"company-test",workspaceId:ctx.workspaceId,status:"ready",revision:"1"};
 const workspace=new LocalProjectWorkspace({get:async()=>project},{root}),checks=[];
 try{
 let f=await workspace.createFile(ctx,project.companyId,project.id,"script.sh","echo old\n");
 const p=path.join(root,project.companyId,project.id,"script.sh");
 for(const mode of [0o755,0o640,0o700]){
 await fs.chmod(p,mode);
 f=await workspace.writeFile(ctx,project.companyId,project.id,"script.sh","echo old\n",f.revision);
 const afterWrite=(await fs.stat(p)).mode&0o777;
 f=await workspace.editFile(ctx,project.companyId,project.id,"script.sh","old","new",f.revision);
 const afterEdit=(await fs.stat(p)).mode&0o777;
 checks.push({mode,afterWrite,afterEdit});
 }
 const passed=checks.every(c=>c.mode===c.afterWrite&&c.mode===c.afterEdit);
 console.log(JSON.stringify({kind:"real-linux-workspace-file-operations",uid:process.getuid(),checks,passed}));
 if(!passed)process.exitCode=1;
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
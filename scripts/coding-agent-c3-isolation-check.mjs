#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
const image=process.argv[process.argv.indexOf("--image")+1], output=process.argv[process.argv.indexOf("--output")+1];
if(!process.argv.includes("--image")||!image||!process.argv.includes("--output")||!output)throw Error("--image and --output required");
const target=path.resolve(output),root=path.resolve("artifacts")+path.sep;
if(!target.startsWith(root))throw Error("Output must remain in artifacts");
const dir=path.resolve("artifacts","c3-isolation-"+randomUUID()), name="npati-c3-isolation-"+randomUUID();
fs.mkdirSync(dir,{recursive:true});
try{
 buildSync({entryPoints:["tests/support/c3-isolation-proof-entry.ts"],outfile:path.join(dir,"proof.cjs"),bundle:true,platform:"node",format:"cjs",target:"node24",loader:{".sql":"text"}});
 fs.copyFileSync("apps/agent-api/project-runtime-guard.c",path.join(dir,"guard.c"));
 const inspect=spawnSync("docker",["image","inspect",image,"--format","{{.Id}}"],{encoding:"utf8",timeout:15000});
 if(inspect.status!==0||!/^sha256:[a-f0-9]{64}\s*$/.test(inspect.stdout))throw Error("Existing local image required");
 const compile=spawnSync("docker",["run","--pull","never","--name",name+"-build","--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--user","0:0","--tmpfs","/tmp:rw,nosuid,nodev,size=64m","--mount","type=bind,src="+dir+",dst=/audit","--entrypoint","/bin/sh",inspect.stdout.trim(),"-c","cc -O2 -Wall -Wextra -Werror /audit/guard.c -lseccomp -o /audit/npati-project-exec"],{encoding:"utf8",timeout:30000});
 if(compile.status!==0)throw Error("Native audit helper compilation failed: "+compile.stderr);
 const flags=["--user","0:0","--rm","--pull","never","--name",name,"--network","none","--read-only","--cap-drop","ALL"];
 // Exact existing shared supervisor capability/namespace profile; no host network,
 // Docker socket, host PID namespace, production volume or container per project.
 for(const cap of ["CHOWN","DAC_OVERRIDE","SETUID","SETGID","KILL","NET_ADMIN"])flags.push("--cap-add",cap);
 flags.push("--security-opt","no-new-privileges","--security-opt","seccomp="+path.resolve("docker/sandbox/project-runtime-seccomp.json"),
 "--security-opt","apparmor=unconfined","--security-opt","systempaths=unconfined","--device","/dev/net/tun:/dev/net/tun",
 "--memory","512m","--cpus","1","--pids-limit","256","--tmpfs","/tmp:rw,nosuid,nodev,size=64m",
 "--tmpfs","/projects:rw,nosuid,nodev,size=32m","--tmpfs","/runtime-state:rw,nosuid,nodev,size=16m",
 "--mount","type=bind,src="+dir+",dst=/audit,readonly","--entrypoint","/bin/sh",inspect.stdout.trim(),
 "-c","node /audit/proof.cjs");
 const r=spawnSync("docker",["run",...flags],{encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});
 let proof;for(const line of (r.stdout??"").trim().split("\n").reverse())try{const candidate=JSON.parse(line);if(candidate.kind==="c3-real-shared-isolation"){proof=candidate;break;}}catch{}
 const report={kind:"c3-shared-isolation-container",imageId:inspect.stdout.trim(),imageAdmissionVerified:false,network:"none",securityProfile:"existing docker-compose.sandbox-runner.yml shared profile; unchanged",status:r.status,passed:r.status===0&&proof?.passed===true,proof,stderr:(r.stderr??"").slice(-8000),...(!proof?{stdoutTail:(r.stdout??"").slice(-8000)}:{}),error:r.error?.message};
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify({passed:report.passed,status:r.status,checks:proof?.checks,blocker:proof?.blocker,diagnostic:proof?.diagnostic,stderr:report.stderr}));
 if(!report.passed)process.exitCode=1;
}finally{
 spawnSync("docker",["rm","-f",name,name+"-build"],{encoding:"utf8",timeout:15000});
 if(!dir.startsWith(root))throw Error("Unsafe cleanup");
 fs.rmSync(dir,{recursive:true,force:true});
}

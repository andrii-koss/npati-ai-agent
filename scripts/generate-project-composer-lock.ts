import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
const directory=path.resolve("artifacts/framework-runtime-locks/Laravel");
await mkdir(directory,{recursive:true});
const files=createFrameworkScaffold({projectName:"npati-framework",framework:"Laravel",prompt:""});
const manifest=JSON.parse(files["composer.json"]!);
await writeFile(path.join(directory,"composer.json"),JSON.stringify(manifest,null,2));
const log=await new Promise<string>((resolve,reject)=>{
 const child=spawn("docker",["run","--rm","--network","npati-isolated-source-20261011_npati-agent","--env","COMPOSER_IPRESOLVE=4","--mount","type=bind,source="+directory+",target=/project","--workdir","/project","--env","COMPOSER_ALLOW_SUPERUSER=1","--entrypoint","/usr/bin/php83","npati-photo-sandbox-local:20261020","/usr/bin/composer.phar","update","--no-install","--no-scripts","--no-interaction","--no-progress"],{windowsHide:true});
 let output="";child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);child.on("error",reject);child.on("close",code=>code===0?resolve(output):reject(Error(output.slice(-2500))));
});
await writeFile(path.join(directory,"install.log"),log);
const file="apps/agent-api/src/project-framework-locks.json",locks=JSON.parse(await readFile(file,"utf8"));
locks.Laravel={composer:JSON.parse(await readFile(path.join(directory,"composer.lock"),"utf8")),composerManifest:manifest};
await writeFile(file,JSON.stringify(locks,null,2)+"\n");
console.log("Laravel: locked");

/** Isolated real-Chromium check of the shipped QA script. No NPATI session, projects or model writes. */
import { chromium as realChromium } from "playwright";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const directory = "artifacts/technology-visual-fix";
const host = "npati-sb-11111111-1111-4111-8111-111111111111";
const html = '<!doctype html><html lang="en"><head><title>Reference capture test</title><style>body{margin:0;background:#faf5e8;font:20px Arial}header{height:100px;background:#354c40;color:white;padding:20px}main{display:grid;grid-template-columns:240px 1fr;gap:32px;padding:40px}aside{height:500px;background:#d4c6a5}section{background:white;padding:32px}input{position:absolute;top:300px;left:20px;width:180px;height:40px}</style></head><body><header>Test Shop</header><main><aside>Categories</aside><section><h1>Product catalog</h1><button>Add to cart</button></section></main><input aria-label="Private" value="PRIVATE_INPUT_SENTINEL"><div data-private style="position:absolute;top:400px;left:20px;width:180px;height:40px">PRIVATE_REGION</div></body></html>';
const server = createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end(html);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
  await mkdir(directory,{recursive:true});
  const source=(await readFile("apps/agent-api/browser-qa-runner.mjs","utf8")).replace('import { chromium } from "playwright";',"");
  const capture=async mode=>{
    let output="";
    const input={host,port:server.address().port,path:"/",viewport:{width:1280,height:800},timeoutMs:30000,maxScreenshotBytes:2000000,maxBrokenLinks:1,screenshot:true,...(mode?{screenshotMode:mode}:{})};
    const processStub={argv:[],env:{},stdin:Readable.from([Buffer.from(JSON.stringify(input))]),stdout:{write:chunk=>{output+=chunk;}},exitCode:0};
    const chromium={launch:options=>realChromium.launch({...options,args:[...options.args,"--no-proxy-server","--host-resolver-rules=MAP "+host+" 127.0.0.1"]})};
    await new (Object.getPrototypeOf(async function(){}).constructor)("chromium","process","Buffer",source)(chromium,processStub,Buffer);
    assert.equal(processStub.exitCode,0,output);
    return JSON.parse(output);
  };
  const visual=await capture("visual"),layout=await capture();
  assert.equal(visual.screenshot.captureMode,"visual");assert.equal(layout.screenshot.captureMode,"layout");
  const visualBytes=Buffer.from(visual.screenshot.base64Data,"base64"),layoutBytes=Buffer.from(layout.screenshot.base64Data,"base64");
  await writeFile(directory+"/qa-actual-visual.png",visualBytes);await writeFile(directory+"/qa-default-layout.png",layoutBytes);
  const browser=await realChromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    const samples=await page.evaluate(async image=>{
      const bytes=Uint8Array.from(atob(image),c=>c.charCodeAt(0));const bmp=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
      const canvas=document.createElement("canvas");canvas.width=bmp.width;canvas.height=bmp.height;const x=canvas.getContext("2d");x.drawImage(bmp,0,0);
      return {header:[...x.getImageData(5,5,1,1).data],privateInput:[...x.getImageData(25,305,1,1).data],privateRegion:[...x.getImageData(25,405,1,1).data]};
    },visual.screenshot.base64Data);
    assert.deepEqual(samples.header,[53,76,64,255]);assert.deepEqual(samples.privateInput,[255,0,255,255]);assert.deepEqual(samples.privateRegion,[255,0,255,255]);
    const result={status:"PASS",kind:"real_shipped_browser_qa_script",visualCaptureMode:visual.screenshot.captureMode,defaultCaptureMode:layout.screenshot.captureMode,samples,visualSha256:createHash("sha256").update(visualBytes).digest("hex"),layoutSha256:createHash("sha256").update(layoutBytes).digest("hex"),visionE2E:"BLOCKED: requires authenticated NPATI test session; this test proves actual capture and masking, not model comparison"};
    await writeFile(directory+"/qa-capture.json",JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();}
}finally{await new Promise(resolve=>server.close(resolve));}

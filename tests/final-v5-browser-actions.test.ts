import { expect, it } from "vitest";
import { chromium } from "playwright";
import { assertBrowserQaActions, runBrowserQaActions } from "../apps/agent-api/browser-qa-actions.mjs";
import { assertBrowserQaOptions } from "../apps/agent-api/src/sandbox-browser-qa";
import { resolveManifestForSession } from "../apps/agent-api/src/code-tool-registry";
it("keeps the v17 schema snapshot immutable",()=>{expect(resolveManifestForSession(17).checksum).toBe("d5d299798efded5866eb1f1b5781381be45b338b69f8efdc16a6f83b69cb7a10");});
it("refuses unbounded actions, credential input, scripts and selector engines",()=>{
  for(const actions of [Array.from({length:17},()=>({type:"wait",durationMs:0})),[{type:"eval",script:"fetch('https://external')"}],[{type:"key",key:"Control"}],[{type:"click",selector:"iframe >> button"}],[{type:"wait",durationMs:2001}],Array.from({length:5},()=>({type:"wait",durationMs:2000}))])expect(()=>assertBrowserQaActions(actions)).toThrow();
  expect(()=>assertBrowserQaOptions({port:3000,path:"/",viewport:{width:800,height:600},timeoutMs:30000,maxScreenshotBytes:500000,maxBrokenLinks:20,screenshot:false,actions:[{type:"key",key:"Control"}]})).toThrow();
});
it("records genuine clicks, disabled controls and held keys without private DOM values",async()=>{
  const browser=await chromium.launch();try{const page=await browser.newPage();await page.setContent('<button id="hit" onclick="this.textContent=Number(this.textContent)+1">0</button><button id="blocked" disabled onclick="this.textContent=99">0</button><p role="status">Idle</p><div data-private>PRIVATE_VALUE</div><input value="PRIVATE_INPUT"><div style="visibility:hidden">HIDDEN_VISIBILITY</div><div style="opacity:0"><button>HIDDEN_OPACITY</button></div><script>onkeydown=e=>{if(e.code==="ArrowRight")document.querySelector("p").textContent="KEY_RIGHT"}</script>');
    const trace=await runBrowserQaActions(page,[{type:"click",selector:"#hit"},{type:"click",selector:"#blocked"},{type:"key",key:"ArrowRight",durationMs:80}]);expect(trace.map(t=>t.status)).toEqual(["completed","completed","completed"]);expect(await page.locator('#hit').innerText()).toBe('1');expect(await page.locator('#blocked').innerText()).toBe('0');expect(trace.at(-1)?.after.text).toContain('KEY_RIGHT');expect(JSON.stringify(trace)).not.toContain('PRIVATE_');expect(JSON.stringify(trace)).not.toContain('HIDDEN_');
  }finally{await browser.close();}
},20000);

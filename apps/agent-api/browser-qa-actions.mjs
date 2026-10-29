/** Bounded local browser input, not script execution. The enclosing runner owns origin/network isolation. */
export const BROWSER_QA_KEYS = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter','Tab','KeyW','KeyA','KeyS','KeyD','KeyR'];
export function assertBrowserQaActions(actions) {
  if(actions===undefined)return;
  if(!Array.isArray(actions)||actions.length>16)throw new Error('invalid_browser_actions');
  let duration=0;
  for(const a of actions){if(!a||typeof a!=='object'||!['click','key','wait'].includes(a.type))throw new Error('invalid_browser_actions');
    const keys=a.type==='click'?['type','selector']:a.type==='key'?['type','key','durationMs']:['type','durationMs'];
    if(Object.keys(a).some(k=>!keys.includes(k)))throw new Error('invalid_browser_actions');
    if(a.type==='click'&&(typeof a.selector!=='string'||!a.selector.trim()||a.selector.length>160||/>>|\0|xpath=|internal:/.test(a.selector)))throw new Error('invalid_browser_actions');
    if(a.type==='key'&&!BROWSER_QA_KEYS.includes(a.key))throw new Error('invalid_browser_actions');
    if(a.type!=='click'){const ms=a.durationMs??(a.type==='key'?80:undefined);if(!Number.isInteger(ms)||ms<0||ms>2000)throw new Error('invalid_browser_actions');duration+=ms;}
  }
  if(duration>8000)throw new Error('invalid_browser_actions');
}
export async function runBrowserQaActions(page,actions=[]) {
  assertBrowserQaActions(actions);const trace=[];
  const observe=()=>page.evaluate(()=>{const text=[];const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);for(let n=walk.nextNode();n;n=walk.nextNode()){const p=n.parentElement;if(!p||p.closest('[data-private],input,textarea,select,[contenteditable],script,style')||!p.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;text.push(n.textContent);}const value=text.join(' ').replace(/\s+/g,' ').trim().slice(0,1400);const buttons=[...document.querySelectorAll('button')].filter(b=>!b.closest('[data-private]')&&b.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).slice(0,32).map(b=>({label:(b.getAttribute('aria-label')??b.textContent??'').trim().slice(0,100),disabled:b.disabled}));const canvas=document.querySelector('canvas');let canvasHash;try{let hash=2166136261;for(const c of canvas?.toDataURL()??'')hash=Math.imul(hash^c.charCodeAt(0),16777619);canvasHash=(hash>>>0).toString(16);}catch{}return{text:value,buttons,canvasHash};});
  for(const action of actions){const before=await observe();try{if(action.type==='click'){const locator=page.locator(action.selector).first();await locator.waitFor({state:'visible',timeout:1500});await locator.scrollIntoViewIfNeeded({timeout:1500});const box=await locator.boundingBox();if(!box)throw Error('not_visible');await page.mouse.click(box.x+box.width/2,box.y+box.height/2);}else if(action.type==='wait'){await page.waitForTimeout(action.durationMs);}else{const key=action.key.startsWith('Key')?action.key.slice(3).toLowerCase():action.key;await page.keyboard.down(key);await page.waitForTimeout(action.durationMs??80);await page.keyboard.up(key);}await page.waitForTimeout(50);trace.push({action,status:'completed',before,after:await observe()});}catch{trace.push({action,status:'failed',before,after:await observe()});break;}}
  return trace;
}

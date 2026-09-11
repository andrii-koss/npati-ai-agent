import {chromium} from "playwright";

const apiBase=process.env.NPATI_API_URL??"http://localhost:3001";
const webBase=process.env.NPATI_WEB_URL??"http://localhost:3000";
const loginResponse=await fetch(apiBase+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:process.env.NPATI_TEST_EMAIL??"webuser1@example.com",password:process.env.NPATI_TEST_PASSWORD??"Password123!"})});
const login=await loginResponse.json();
if(!loginResponse.ok)throw new Error("Login failed: "+JSON.stringify(login));
const headers={authorization:"Bearer "+login.tokens.accessToken,"content-type":"application/json"};
const conversationResponse=await fetch(apiBase+"/conversations",{method:"POST",headers,body:JSON.stringify({title:"Streaming verification"})});
const conversation=await conversationResponse.json();
if(!conversationResponse.ok)throw new Error("Could not create neutral conversation: "+JSON.stringify(conversation));

let browser;
try{
  browser=await chromium.launch({channel:"msedge",headless:true});
  const page=await browser.newPage();
  await page.addInitScript(({token,user})=>{localStorage.setItem("npati_agent_access_token",token);localStorage.setItem("npati_agent_user",JSON.stringify(user));},{token:login.tokens.accessToken,user:login.user});
  await page.goto(webBase+"/c/"+conversation.id,{waitUntil:"networkidle"});
  const privateLabel=page.getByText("Private request",{exact:true}).first().locator("..");
  await privateLabel.click();
  const streamRequest=page.waitForRequest(request=>request.url().includes("/api/chat/stream")&&request.method()==="POST");
  await page.locator("textarea").last().fill("Reply with exactly: STREAM-WEBCHAT-OK");
  await page.getByRole("button",{name:/Send/}).last().click();
  const outgoing=await streamRequest;
  const payload=outgoing.postDataJSON();
  await page.getByText("STREAM-WEBCHAT-OK",{exact:false}).last().waitFor({timeout:150_000});
  if(payload.contextType!=="none"||payload.noMemory!==true)throw new Error("WebChat sent an incorrect streaming payload: "+JSON.stringify(payload));
  console.log(JSON.stringify({webChatRenderedStreamedAnswer:true,endpoint:"/api/chat/stream",contextType:payload.contextType,noMemory:payload.noMemory},null,2));
}finally{
  await browser?.close().catch(()=>undefined);
  await fetch(apiBase+"/conversations/"+conversation.id,{method:"DELETE",headers}).catch(()=>undefined);
}

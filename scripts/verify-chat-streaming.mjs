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

let browser,businessId;
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

  const businessResponse=await fetch(apiBase+"/businesses",{method:"POST",headers,body:JSON.stringify({name:"Streaming cancellation verification "+Date.now(),businessStage:"operating"})});
  const business=await businessResponse.json();if(!businessResponse.ok)throw new Error("Could not create cancellation business: "+JSON.stringify(business));businessId=business.id;
  const businessConversationResponse=await fetch(apiBase+`/businesses/${businessId}/conversations`,{method:"POST",headers,body:JSON.stringify({title:"Cancellation verification"})});
  const businessConversation=await businessConversationResponse.json();if(!businessConversationResponse.ok)throw new Error("Could not create business conversation: "+JSON.stringify(businessConversation));
  await page.goto(webBase+"/c/"+businessConversation.id,{waitUntil:"networkidle"});
  const cancellationRequest=page.waitForRequest(request=>request.url().includes("/api/chat/stream")&&request.method()==="POST");
  await page.locator("textarea").last().fill("Write a very long plain-text answer of at least 2000 words.");
  await page.getByRole("button",{name:/Send/}).last().click();await cancellationRequest;
  const stop=page.getByRole("button",{name:"Stop"}).last();await stop.waitFor();await stop.click();
  await page.waitForTimeout(6_000);
  const historyResponse=await fetch(apiBase+`/businesses/${businessId}/conversations/${businessConversation.id}`,{headers});
  const history=await historyResponse.json();if(!historyResponse.ok)throw new Error("Could not inspect cancellation history: "+JSON.stringify(history));
  const roles=history.messages.map(message=>message.role);
  if(roles.includes("assistant"))throw new Error("Stop failed: a late assistant response was persisted: "+JSON.stringify(roles));
  console.log(JSON.stringify({webChatRenderedStreamedAnswer:true,endpoint:"/api/chat/stream",contextType:payload.contextType,noMemory:payload.noMemory,businessStopCancelledProvider:true,lateAssistantPersisted:false},null,2));
}finally{
  await browser?.close().catch(()=>undefined);
  if(businessId)await fetch(apiBase+"/businesses/"+businessId,{method:"DELETE",headers}).catch(()=>undefined);
  await fetch(apiBase+"/conversations/"+conversation.id,{method:"DELETE",headers}).catch(()=>undefined);
}

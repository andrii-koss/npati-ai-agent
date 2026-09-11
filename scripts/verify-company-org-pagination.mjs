import {chromium} from "playwright";

const apiBase=process.env.NPATI_API_URL??"http://localhost:3001",webBase=process.env.NPATI_WEB_URL??"http://localhost:3000";
const loginResponse=await fetch(apiBase+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:process.env.NPATI_TEST_EMAIL??"webuser1@example.com",password:process.env.NPATI_TEST_PASSWORD??"Password123!"})});
const login=await loginResponse.json();if(!loginResponse.ok)throw new Error("Login failed: "+JSON.stringify(login));
const headers={authorization:"Bearer "+login.tokens.accessToken,"content-type":"application/json"};
async function request(path,method="GET",body,idempotencyKey){const response=await fetch(apiBase+path,{method,headers:{...headers,...(idempotencyKey?{"idempotency-key":idempotencyKey}:{})},body:body?JSON.stringify(body):undefined});const value=response.status===204?undefined:await response.json();if(!response.ok)throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(value)}`);return value;}

let companyId,browser;
try{
  const stamp=Date.now();const company=await request("/companies","POST",{name:"Pagination verification "+stamp},"pagination-company-"+stamp);companyId=company.id;
  const agents=[];
  for(let offset=0;offset<121;offset+=20){const batch=await Promise.all(Array.from({length:Math.min(20,121-offset)},(_,index)=>{const number=offset+index+1;return request(`/companies/${companyId}/agents`,"POST",{name:`Pagination Agent ${String(number).padStart(3,"0")}`,role:"Worker"},`pagination-agent-${stamp}-${number}`);}));agents.push(...batch);}
  await request(`/companies/${companyId}/main-agent`,"PUT",{agentId:agents[0].id,expectedRevision:company.revision});
  await request(`/companies/${companyId}/agents/${agents[70].id}/parent`,"PUT",{parentAgentId:agents[0].id});

  browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage();
  await page.addInitScript(({token,user})=>{localStorage.setItem("npati_agent_access_token",token);localStorage.setItem("npati_agent_user",JSON.stringify(user));},{token:login.tokens.accessToken,user:login.user});
  const edgeRequestSizes=[];page.on("request",request=>{if(request.url().includes(`/companies/${companyId}/agent-edges?`)){const ids=new URL(request.url()).searchParams.get("agentIds")?.split(",").filter(Boolean)??[];edgeRequestSizes.push(ids.length);}});
  await page.goto(webBase+"/company",{waitUntil:"networkidle"});await page.getByLabel("Select company").selectOption(companyId);await page.getByText("Pagination Agent",{exact:false}).first().waitFor();
  for(let pageNumber=0;pageNumber<2;pageNumber+=1){
    const button=page.getByRole("button",{name:"Load more agents"});
    await button.waitFor();
    const agentsResponse=page.waitForResponse(response=>response.request().method()==="GET"&&response.url().includes(`/companies/${companyId}/agents?limit=60`));
    await button.click();
    const response=await agentsResponse;
    if(!response.ok())throw new Error(`Agent page ${pageNumber+2} failed: ${response.status()}`);
  }
  await page.getByText("Pagination Agent 121",{exact:true}).waitFor();
  if(edgeRequestSizes.length<3||edgeRequestSizes.some(size=>size>61))throw new Error("Org Chart made an unbounded edge request: "+JSON.stringify(edgeRequestSizes));
  const inspection=await request("/capabilities/inspect");
  const capability=inspection.items.find(item=>item.id===286);
  if(capability?.status!=="VERIFIED_EXISTING")throw new Error("Capability #286 is not Verified in runtime inspector: "+JSON.stringify(capability));
  console.log(JSON.stringify({agentsCreated:121,pagesLoaded:3,edgeRequestSizes,maxEdgeRequestSize:Math.max(...edgeRequestSizes),agent121Visible:true,capability286:capability.status},null,2));
}finally{await browser?.close().catch(()=>undefined);if(companyId)await request("/companies/"+companyId,"DELETE").catch(()=>undefined);}

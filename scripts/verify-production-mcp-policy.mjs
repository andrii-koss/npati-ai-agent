const base=process.env.NPATI_API_URL??"http://localhost:3001";
const stamp=Date.now();
const loginResponse=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"webuser1@example.com",password:"Password123!"})});
const login=await loginResponse.json();if(!loginResponse.ok)throw new Error(JSON.stringify(login));
const bearer={authorization:"Bearer "+login.tokens.accessToken};
let requestSequence=0;
async function user(path,method="GET",body){
  const response=await fetch(base+path,{method,headers:{...bearer,...(body?{"content-type":"application/json"}:{}),...(method==="POST"?{"idempotency-key":"mcp-policy-"+stamp+"-"+(++requestSequence)}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text(),value=text?JSON.parse(text):undefined;
  if(!response.ok)throw new Error(method+" "+path+" "+response.status+" "+text);
  return value;
}
async function mcp(token,name,expected){
  const response=await fetch(base+"/company-api/mcp/call",{method:"POST",headers:{"x-npati-api-key":token,"content-type":"application/json"},body:JSON.stringify({name})});
  const text=await response.text(),value=text?JSON.parse(text):undefined;
  if(response.status!==expected)throw new Error("MCP "+name+" expected "+expected+", got "+response.status+": "+text);
  return value;
}
let companyId,keyId;
try{
  const company=await user("/companies","POST",{name:"MCP Policy E2E "+stamp});
  companyId=company.id;
  const allowed=(await user("/companies/"+companyId+"/api-keys","POST",{name:"MCP read",scopes:["mcp:read"]})).key;
  const denied=(await user("/companies/"+companyId+"/api-keys","POST",{name:"Chat only",scopes:["chat:write"]})).key;
  keyId=allowed.id;
  const missingScope=await mcp(denied.rawToken,"omniroute_get_health",403);
  const unsafeTool=await mcp(allowed.rawToken,"omniroute_create_combo",403);
  const health=await mcp(allowed.rawToken,"omniroute_get_health",200);
  await user("/companies/"+companyId+"/api-keys/"+allowed.id,"DELETE");
  const revoked=await mcp(allowed.rawToken,"omniroute_get_health",401);
  const inspector=await user("/capabilities/inspect");
  console.log(JSON.stringify({
    scopedReadExecuted:Boolean(health?.result),missingScopeDenied:missingScope?.error?.code==="API_KEY_SCOPE_DENIED",
    unsafeToolDenied:unsafeTool?.error?.code==="MCP_TOOL_DENIED",revokedKeyDenied:Boolean(revoked?.error),
    statuses:(inspector.capabilities??inspector.items??[]).filter(item=>[40,48,102].includes(item.id??item.capability?.id)).map(item=>item.status??item.effectiveStatus),
  },null,2));
}finally{
  if(companyId)await user("/companies/"+companyId,"DELETE").catch(()=>undefined);
}

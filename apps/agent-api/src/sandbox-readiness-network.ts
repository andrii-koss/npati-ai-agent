/** Dedicated infrastructure for readiness probes; no Project workload runs here. */
export const READINESS_EGRESS_SCOPE = {proxy:"npati-readiness-egress",network:"npati-readiness-net"};

export function createReadinessNetwork(options: {
  docker: (args:string[],timeoutMs?:number)=>Promise<{ok:boolean;output:string}>;
  image:string;
  allowedHosts:string;
}) {
  let preparing:Promise<void>|undefined;
  const command=async(args:string[])=>{
    const result=await options.docker(args,15000);
    if(!result.ok)throw new Error("Readiness network setup failed: "+result.output.slice(-300));
    return result.output;
  };
  const inspect=async(kind:"network"|"container",name:string)=>{
    const result=await options.docker([kind,"inspect",name],15000);
    if(!result.ok){
      if(/no such (?:network|container|object)|not found/i.test(result.output))return undefined;
      throw new Error("Readiness inspection failed: "+result.output.slice(-300));
    }
    return JSON.parse(result.output)[0];
  };
  const prepare=async()=>{
    const {proxy,network}=READINESS_EGRESS_SCOPE;
    const existing=await inspect("network",network);
    if(!existing)await command(["network","create","--driver","bridge","--internal","--opt","com.docker.network.bridge.gateway_mode_ipv4=isolated","--label","npati.readiness=egress",network]);
    else if(existing.Internal!==true || existing.Options?.["com.docker.network.bridge.gateway_mode_ipv4"]!=="isolated" || existing.Labels?.["npati.readiness"]!=="egress")throw new Error("Readiness network is not the managed isolated network");
    let container=await inspect("container",proxy);
    if(container){
      if(container.Config?.Labels?.["npati.readiness"]!=="egress")throw new Error("Readiness proxy is not the configured managed proxy");
      if(container.Config?.Image!==options.image || !container.Config?.Env?.includes(`ALLOWED_HOSTS=${options.allowedHosts}`)){
        // Only this labelled readiness proxy is disposable; Project proxies are untouched.
        await command(["rm","--force",proxy]);
        container=undefined;
      }
    }
    if(!container)await command(["create","--name",proxy,"--label","npati.readiness=egress","--network","bridge","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","64","--read-only","--tmpfs","/tmp:rw,nosuid,nodev,size=16m","--env",`ALLOWED_HOSTS=${options.allowedHosts}`,options.image]);
    if(!container?.NetworkSettings?.Networks?.[network])await command(["network","connect","--alias","egress",network,proxy]);
    await command(["start",proxy]);
    // Docker start returns before Node starts listening. Bound the warm-up retry.
    for(let attempt=0;attempt<10;attempt++){
      const health=await options.docker(["exec",proxy,"node","-e","const http=require('http');const r=http.get('http://127.0.0.1:8080/_npati/health',res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===200?0:1));});r.setTimeout(1000,()=>r.destroy());r.on('error',()=>process.exit(1));"],3000);
      if(health.ok)return;
      if(attempt<9)await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw new Error("Readiness proxy did not become healthy");
  };
  return ()=>{
    if(!preparing)preparing=prepare().finally(()=>{preparing=undefined;});
    return preparing;
  };
}

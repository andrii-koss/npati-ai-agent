import {describe,it,expect,vi} from "vitest";
import {createReadinessNetwork,READINESS_EGRESS_SCOPE} from "../apps/agent-api/src/sandbox-readiness-network";
import {createRunnerReadiness} from "../apps/agent-api/src/runner-readiness";
import {EgressEnforcement} from "../apps/agent-api/src/sandbox-egress-enforcement";

describe("Sandbox readiness infrastructure",()=>{
  it("prepares the isolated network and proxy on a fresh runner and reuses them",async()=>{
    let network:any,container:any;
    const docker=vi.fn(async(args:string[])=>{
      if(args[1]==="inspect"){
        const object=args[0]==="network"?network:container;
        return object?{ok:true,output:JSON.stringify([object])}:{ok:false,output:"No such object"};
      }
      if(args[0]==="network"&&args[1]==="create")network={Internal:true,Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"},Labels:{"npati.readiness":"egress"}};
      if(args[0]==="create")container={Config:{Image:args.at(-1),Env:[args[args.indexOf("--env")+1]],Labels:{"npati.readiness":"egress"}},NetworkSettings:{Networks:{}}};
      if(args[0]==="network"&&args[1]==="connect")container.NetworkSettings.Networks[READINESS_EGRESS_SCOPE.network]={};
      return {ok:true,output:"ok"};
    });
    const prepare=createReadinessNetwork({docker,image:"proxy-image",allowedHosts:"registry.npmjs.org"});
    await Promise.all([prepare(),prepare()]);
    expect(docker.mock.calls.filter(([args])=>args[0]==="create")).toHaveLength(1);
    expect(docker.mock.calls.find(([args])=>args[1]==="create")![0]).toContain("--internal");
    await prepare();
    expect(docker.mock.calls.filter(([args])=>args[0]==="create")).toHaveLength(1);
    expect(docker.mock.calls.every(([args])=>!args.includes("npati-egress"))).toBe(true);
    await createReadinessNetwork({docker,image:"proxy-image-v2",allowedHosts:"registry.npmjs.org"})();
    expect(docker.mock.calls.filter(([args])=>args[0]==="create")).toHaveLength(2);
    expect(docker).toHaveBeenCalledWith(["rm","--force",READINESS_EGRESS_SCOPE.proxy],15000);
  });
  it("refuses a preexisting public network instead of claiming enforcement",async()=>{
    const docker=vi.fn(async()=>({ok:true,output:JSON.stringify([{Internal:false,Labels:{"npati.readiness":"egress"}}])}));
    await expect(createReadinessNetwork({docker,image:"proxy-image",allowedHosts:""})()).rejects.toThrow("not the managed isolated network");
    expect(docker).toHaveBeenCalledTimes(1);
  });
  it("refuses to replace a proxy without the readiness ownership label",async()=>{
    const docker=vi.fn(async(args:string[])=>({ok:true,output:JSON.stringify([args[0]==="network"?
      {Internal:true,Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"},Labels:{"npati.readiness":"egress"}}:
      {Config:{Image:"unmanaged",Labels:{}}}])}));
    await expect(createReadinessNetwork({docker,image:"proxy-image",allowedHosts:""})()).rejects.toThrow("not the configured managed proxy");
    expect(docker.mock.calls.every(([args])=>args[0]!=="rm")).toBe(true);
  });
  it("reports a setup failure as not ready before running enforcement probes",async()=>{
    const probe={proxyHealth:vi.fn(async()=>({ok:true})),directEgressBlocked:vi.fn(async()=>({blocked:true})),dnsBypassBlocked:vi.fn(async()=>({blocked:true}))};
    const readiness=createRunnerReadiness({docker:async()=>({ok:true,output:"ok"}),images:{sandbox:"sandbox",egressProxy:"proxy"},enforcement:new EgressEnforcement({probe}),prepareEgress:async()=>{throw new Error("proxy setup failed");}});
    expect(await readiness.collect(true)).toMatchObject({overall_ready:false,egress_proxy_ready:false,details:{enforcementDetails:{detail:"proxy setup failed"}}});
    expect(probe.proxyHealth).not.toHaveBeenCalled();
  });
});

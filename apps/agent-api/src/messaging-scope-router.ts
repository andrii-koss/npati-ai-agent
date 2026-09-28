import type { AuthContext, Company, CompanyAgent, WorkspaceStore } from "@npati/workspace";
import type { MessagingConnection, MessagingIntegrationsRepository, MessagingSession } from "./messaging-integrations-repository";

export type MessagingScopeResolution={handled:boolean;message?:string;company?:Company;agent?:CompanyAgent};
const normalized=(value:string)=>value.trim().toLocaleLowerCase();
function requestedName(text:string,kind:"company"|"agent"){
  const slash=new RegExp(`^/${kind}\\s+(.+)$`,"iu").exec(text.trim());if(slash)return slash[1]!.trim();
  const label=kind==="company"?"(?:company|компан(?:ію|ию|ія|ия))":"(?:agent|агент(?:а|ом)?)";
  return new RegExp(`^(?:switch(?:\\s+to)?|use|select|переключ(?:ись|и)?(?:\\s+на)?|перемкни(?:сь)?(?:\\s+на)?|обери|вибери)\\s+${label}\\s+(.+)$`,"iu").exec(text.trim())?.[1]?.trim();
}
function exactOrUnique<T extends {name:string}>(items:T[],query:string){const name=normalized(query),exact=items.filter((item)=>normalized(item.name)===name);if(exact.length===1)return exact[0];const partial=items.filter((item)=>normalized(item.name).includes(name));return partial.length===1?partial[0]:undefined;}

export class MessagingScopeRouter{
  constructor(private readonly store:WorkspaceStore,private readonly repo:MessagingIntegrationsRepository){}
  async resolve(ctx:AuthContext,connection:MessagingConnection,text:string,session?:MessagingSession):Promise<MessagingScopeResolution>{
    const channelName=connection.channel.charAt(0).toUpperCase()+connection.channel.slice(1);
    const fixedCompanyId=connection.scope==="account"?(session?.activeCompanyId??connection.activeCompanyId):connection.companyId;
    const fixedAgentId=connection.scope==="account"?(session?.activeAgentId??connection.activeAgentId):connection.agentId;
    if(connection.scope!=="account"){
      const company=fixedCompanyId?await this.store.getCompany(ctx,fixedCompanyId):undefined;
      const agent=company&&fixedAgentId?await this.store.getCompanyAgent(ctx,company.id,fixedAgentId):undefined;
      const command=text.trim();
      if(/^\/context$/iu.test(command))return{handled:true,message:`Fixed ${channelName} context: ${company?.name||"Company"}${agent?` → ${agent.name}`:" → Company Main Agent"}.`};
      if(/^\/(?:account|clear_context|companies|company|agents|agent)(?:\s|$)/iu.test(command))return{handled:true,message:`This ${channelName} connection is locked to ${agent?`Agent ${agent.name} in `:""}Company ${company?.name||"its configured Company"}. Change Connection scope in Settings → Integrations to use account-wide switching.`};
      return{handled:false,company,agent};
    }
    const command=text.trim();
    if(/^\/(?:account|clear_context)$/iu.test(command)){await this.repo.setActiveContext(connection,null,null,session);return{handled:true,message:`Active ${channelName} context cleared. Messages now use your entire NPATI account.`};}
    const page=await this.store.listCompanies(ctx,100),companies=page.items;
    if(/^\/companies$/iu.test(command))return{handled:true,message:companies.length?`Your Companies:\n${companies.map((item)=>`• ${item.name}`).join("\n")}\n\nUse /company Company name to select one.`:"No Companies found. You can ask NPATI to create one."};
    if(/^\/company$/iu.test(command))return{handled:true,message:"Usage: /company Company name. Use /companies to see available Companies."};
    const companyName=requestedName(command,"company");
    if(companyName){const company=exactOrUnique(companies,companyName);if(!company)return{handled:true,message:`I could not uniquely match Company “${companyName}”. Use /companies to see available Companies.`};await this.repo.setActiveContext(connection,company.id,null,session);return{handled:true,message:`Active ${channelName} context: Company ${company.name}. Use /agents to select a specific Agent or /account to return to account scope.`};}
    const company=fixedCompanyId?companies.find((item)=>item.id===fixedCompanyId):undefined;
    if(/^\/agents$/iu.test(command)){if(!company)return{handled:true,message:"Select a Company first with /company Company name."};const agents=(await this.store.listCompanyAgentsPage(ctx,company.id,100)).items.filter((item)=>item.isActive);return{handled:true,message:agents.length?`Active Agents in ${company.name}:\n${agents.map((item)=>`• ${item.name} — ${item.role}`).join("\n")}\n\nUse /agent Agent name to select one.`:"This Company has no active Agents."};}
    if(/^\/agent$/iu.test(command))return{handled:true,message:"Usage: /agent Agent name. Use /agents to see active Agents in the selected Company."};
    const agentName=requestedName(command,"agent");
    if(agentName){if(!company)return{handled:true,message:"Select a Company first with /company Company name."};const agents=(await this.store.listCompanyAgentsPage(ctx,company.id,100)).items.filter((item)=>item.isActive),agent=exactOrUnique(agents,agentName);if(!agent)return{handled:true,message:`I could not uniquely match Agent “${agentName}”. Use /agents to see active Agents.`};await this.repo.setActiveContext(connection,company.id,agent.id,session);return{handled:true,message:`Active ${channelName} context: ${company.name} → ${agent.name}. Use /company or /account to switch context.`};}
    const activeAgent=company&&fixedAgentId?await this.store.getCompanyAgent(ctx,company.id,fixedAgentId).catch(()=>undefined):undefined;
    if(/^\/context$/iu.test(command))return{handled:true,message:company?`Active ${channelName} context: ${company.name}${activeAgent?` → ${activeAgent.name}`:" → Company Main Agent"}.`:`Active ${channelName} context: Entire NPATI Account.`};
    return{handled:false,company,agent:activeAgent};
  }
}

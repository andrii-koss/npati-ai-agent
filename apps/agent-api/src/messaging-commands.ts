export const messagingCommandDefinitions=[
  {name:"status",description:"Show connection and request status"},
  {name:"new",description:"Start a new NPATI session"},
  {name:"reset",description:"Reset the current NPATI session"},
  {name:"stop",description:"Stop the active request"},
  {name:"companies",description:"List Companies"},
  {name:"company",description:"Select a Company",options:[{name:"name",description:"Company name",type:3,required:false}]},
  {name:"agents",description:"List active Agents"},
  {name:"agent",description:"Select an Agent",options:[{name:"name",description:"Agent name",type:3,required:false}]},
  {name:"context",description:"Show active context"},
  {name:"account",description:"Use the entire NPATI account"},
  {name:"runs",description:"List tasks and Automation runs"},
  {name:"tasks",description:"List tasks and Automation runs"},
  {name:"approvals",description:"List pending approvals"},
  {name:"approve",description:"Approve an action",options:[{name:"id",description:"Approval ID",type:3,required:false}]},
  {name:"deny",description:"Deny an action",options:[{name:"id",description:"Approval ID",type:3,required:false}]},
] as const;

export const messagingCommandNames=messagingCommandDefinitions.map((command)=>command.name);

export function messagingSlashCommand(name:string,options?:Array<{name?:string;value?:unknown}>){
  const values=(options||[]).map((option)=>String(option.value??"").trim()).filter(Boolean);
  return "/"+name+(values.length?" "+values.join(" "):"");
}

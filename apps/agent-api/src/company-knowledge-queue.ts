import { createClient } from "redis";
import { CompanyKnowledgeProcessor,CompanyKnowledgeRepository } from "./company-knowledge";
const STREAM="npati:knowledge-documents:v1",GROUP="npati-knowledge-workers";
type Client=ReturnType<typeof createClient>;
async function group(c:Client){try{await c.sendCommand(["XGROUP","CREATE",STREAM,GROUP,"0","MKSTREAM"]);}catch(e){if(!String(e).includes("BUSYGROUP"))throw e;}}
export class CompanyKnowledgeQueue {
 private client?:Client;
 constructor(private url:string){}
 private async get(){if(this.client?.isReady)return this.client;this.client=createClient({url:this.url});this.client.on("error",()=>undefined);await this.client.connect();await group(this.client);return this.client;}
 async enqueue(documentId:string){await (await this.get()).sendCommand(["XADD",STREAM,"*","documentId",documentId]);}
 async close(){if(this.client?.isOpen)await this.client.quit();}
}
export class CompanyKnowledgeWorker {
 private client?:Client;private stopped=false;private id=`knowledge-${process.pid}-${Math.random().toString(36).slice(2)}`;
 constructor(private url:string,private repo:CompanyKnowledgeRepository,private processor:CompanyKnowledgeProcessor){}
 async start(){this.client=createClient({url:this.url});this.client.on("error",()=>undefined);await this.client.connect();await group(this.client);for(const id of await this.repo.recover())await this.client.sendCommand(["XADD",STREAM,"*","documentId",id]);while(!this.stopped){const raw=await this.client.sendCommand(["XREADGROUP","GROUP",GROUP,this.id,"COUNT","1","BLOCK","5000","STREAMS",STREAM,">"]).catch(()=>null) as any;const messages=raw?.[0]?.messages??raw?.[0]?.[1]??[];for(const m of messages){const mid=m.id??m[0],fields=m.message??m[1],documentId=fields?.documentId??(Array.isArray(fields)?fields[fields.indexOf("documentId")+1]:undefined);if(!documentId)continue;try{await this.processor.process(String(documentId),this.id);}catch{}await this.client.sendCommand(["XACK",STREAM,GROUP,String(mid)]);}}}
 async stop(){this.stopped=true;if(this.client?.isOpen)await this.client.quit();}
}

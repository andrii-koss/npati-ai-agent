import { createHash,randomUUID } from "node:crypto";
import type { FastifyInstance,FastifyRequest } from "fastify";
import { WorkspaceAccessError,type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { ObjectStorage } from "./object-storage";
import { NPATI_BUCKETS,objectKey,objectKeySegment } from "./object-storage";
import type { FileMetadataRepository } from "./file-metadata";
import { CompanyKnowledgeProcessor,CompanyKnowledgeRepository } from "./company-knowledge";
import type { CompanyKnowledgeQueue } from "./company-knowledge-queue";
import { cleanupStoredFileObject } from "./file-cleanup";
import { AutomaticMemoryExtractor } from "./automatic-memory-extractor";
import { MemoryRerankEngine, type DecayingMemoryItem, type MemoryDecayType } from "./advanced-memory-management";
const allowed=new Set(["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-excel","application/x-excel","application/excel","application/x-msexcel","application/msword","text/plain","text/markdown","text/csv","text/tab-separated-values","application/json","application/xml","text/xml"]);
function resolveMime(filename:string,mime:string):string{
 const raw=(mime||"").toLowerCase().split(";")[0]!.trim();
 const ext=filename.split(".").pop()?.toLowerCase();
 if(ext==="xlsx"||raw==="application/vnd.ms-excel"||raw==="application/x-msexcel"||raw==="application/x-excel"||raw==="application/excel"){
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
 }
 if(ext==="xls")return "application/vnd.ms-excel";
 if(ext==="docx")return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
 if(ext==="doc")return "application/msword";
 if(ext==="pdf")return "application/pdf";
 if(ext==="csv")return "text/csv";
 if(ext==="tsv")return "text/tab-separated-values";
 if(ext==="txt")return "text/plain";
 if(ext==="md"||ext==="markdown")return "text/markdown";
 if(ext==="json")return "application/json";
 if(ext==="xml")return "application/xml";
 return raw;
}
async function ctx(auth:AuthProvider,r:FastifyRequest,permission:"workspace:read"|"business:manage"){const c=await auth.authenticate(r);if(!c.permissions.includes(permission))throw new WorkspaceAccessError("Missing permission: "+permission);return c;}
function key(r:FastifyRequest){const v=r.headers["idempotency-key"];if(typeof v!=="string"||!/^[A-Za-z0-9._:-]{8,200}$/.test(v))throw Error("A valid Idempotency-Key header is required");return v;}
function normalizeWikiPath(value:string){const path=(value??"").normalize("NFKC").trim().toLocaleLowerCase().replace(/\\/g,"/").replace(/\s+/g,"-");if(!/^[\p{L}\p{N}_\-/]{1,180}$/u.test(path)||path.includes("..")||path.startsWith("/")||path.endsWith("/"))throw Error("Invalid wiki path");return path;}
function err(reply:any,e:unknown){const status=Number((e as any)?.status??(e instanceof WorkspaceAccessError?403:400));return reply.code(status).send({error:{code:status===404?"NOT_FOUND":"KNOWLEDGE_ERROR",message:e instanceof Error?e.message:String(e)}});}
export function registerCompanyKnowledgeRoutes(app:FastifyInstance,deps:{auth:AuthProvider;store:WorkspaceStore;repo:CompanyKnowledgeRepository;files:FileMetadataRepository;storage:ObjectStorage;processor:CompanyKnowledgeProcessor;queue?:CompanyKnowledgeQueue}){
 const {auth,store,repo,files,storage,processor,queue}=deps;
 app.get<{Params:{companyId:string};Querystring:{limit?:string;cursor?:string}}>("/companies/:companyId/knowledge/documents",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);return {documents:await repo.list(c,r.params.companyId,Number(r.query.limit??50),r.query.cursor)};}catch(e){return err(reply,e);}});
 app.post<{Params:{companyId:string};Body:{filename:string;mimeType:string;data:string}}>("/companies/:companyId/knowledge/documents",{bodyLimit:36*1024*1024,schema:{body:{type:"object",required:["filename","mimeType","data"],additionalProperties:false,properties:{filename:{type:"string",maxLength:255},mimeType:{type:"string",maxLength:150},data:{type:"string",maxLength:40000000}}}}},async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);const idem=key(r),mime=resolveMime(r.body.filename,r.body.mimeType);if(!allowed.has(mime))throw Error("Unsupported knowledge document MIME type: "+(r.body.mimeType||mime));const data=Buffer.from(r.body.data,"base64");if(!data.length||data.length>25*1024*1024)throw Error("Document must be between 1 byte and 25 MB");const fileId=randomUUID(),checksum=createHash("sha256").update(data).digest("hex");const reserved=await files.reserve(c,{id:fileId,workspaceId:c.workspaceId,userId:c.userId,companyId:r.params.companyId,bucket:NPATI_BUCKETS.knowledge,objectKey:objectKey(["workspace",objectKeySegment(c.workspaceId),"companies",objectKeySegment(r.params.companyId),"knowledge",fileId]),originalFilename:r.body.filename.replace(/[^\p{L}\p{N}._ -]/gu,"_").slice(0,255),mimeType:mime,sizeBytes:data.length,checksum,category:"document",idempotencyKey:"knowledge:"+idem});if(reserved.created){try{await storage.put(reserved.file.bucket,reserved.file.objectKey,data,{"content-type":mime,checksum});await files.markReady(c,reserved.file.id);await files.audit(c,reserved.file.id,"upload","succeeded",{companyId:r.params.companyId});}catch(e){await files.markFailed(c,reserved.file.id);throw e;}}const created=await repo.create(c,r.params.companyId,reserved.file.id,idem);if(created.created||created.document.status==="uploaded"){if(queue)await queue.enqueue(created.document.id);else void processor.process(created.document.id).catch(()=>undefined);}return reply.code(created.created?202:200).send(created.document);}catch(e){return err(reply,e);}});
 app.get<{Params:{companyId:string;documentId:string}}>("/companies/:companyId/knowledge/documents/:documentId/content",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");const d=await repo.get(c,r.params.companyId,r.params.documentId),f=await files.get(d.fileId);if(!f||f.workspaceId!==c.workspaceId||f.userId!==c.userId||f.companyId!==r.params.companyId||f.status!=="ready")throw Object.assign(Error("Knowledge file not found"),{status:404});await files.audit(c,f.id,"download","succeeded",{companyId:r.params.companyId});reply.header("content-type",f.mimeType).header("content-disposition",`attachment; filename*=UTF-8''${encodeURIComponent(f.originalFilename)}`);return reply.send(await storage.get(f.bucket,f.objectKey));}catch(e){return err(reply,e);}});
 app.post<{Params:{companyId:string;documentId:string}}>("/companies/:companyId/knowledge/documents/:documentId/reprocess",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await repo.retry(c,r.params.companyId,r.params.documentId);if(queue)await queue.enqueue(r.params.documentId);else void processor.process(r.params.documentId).catch(()=>undefined);return reply.code(202).send(await repo.get(c,r.params.companyId,r.params.documentId));}catch(e){return err(reply,e);}});
 app.delete<{Params:{companyId:string;documentId:string}}>("/companies/:companyId/knowledge/documents/:documentId",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");const document=await repo.get(c,r.params.companyId,r.params.documentId);await processor.deleteDocumentVectors(document);const removed=await repo.remove(c,r.params.companyId,r.params.documentId);const f=removed.alreadyDeleted?await files.get(removed.document.fileId):await files.markDeleted(c,removed.document.fileId);if(f&&!f.storageDeletedAt)await cleanupStoredFileObject(storage,files,f,{context:c,action:"delete",detail:{companyId:r.params.companyId}});return reply.code(204).send();}catch(e){return err(reply,e);}});
 app.get<{Params:{companyId:string}}>("/companies/:companyId/knowledge/memory",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);return {memories:await repo.memories(c,r.params.companyId)};}catch(e){return err(reply,e);}});
 app.post<{Params:{companyId:string};Body:{content:string;source?:string;type?:MemoryDecayType;weight?:number;title?:string}}>("/companies/:companyId/knowledge/memory",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!r.body.content?.trim())throw Error("Memory content is required");const type=r.body.type??"operational";if(!["ephemeral","operational","project_rule","immutable"].includes(type))throw Error("Invalid memory decay type");const weight=r.body.weight??1;if(!Number.isFinite(weight)||weight<0||weight>1)throw Error("Memory weight must be between 0 and 1");return reply.code(201).send(await repo.addMemory(c,r.params.companyId,r.body.content,r.body.source,{type,weight,title:r.body.title?.trim()||undefined}));}catch(e){return err(reply,e);}});
 app.put<{Params:{companyId:string;memoryId:string};Body:{content:string}}>("/companies/:companyId/knowledge/memory/:memoryId",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!r.body.content?.trim())throw Error("Memory content is required");return reply.code(200).send(await repo.updateMemory(c,r.params.companyId,r.params.memoryId,r.body.content));}catch(e){return err(reply,e);}});
 app.delete<{Params:{companyId:string;memoryId:string}}>("/companies/:companyId/knowledge/memory/:memoryId",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");if(!await repo.deleteMemory(c,r.params.companyId,r.params.memoryId))throw Object.assign(Error("Company memory not found"),{status:404});return reply.code(204).send();}catch(e){return err(reply,e);}});
  app.post<{Params:{companyId:string};Body:{date?:string;topic:string;content:string;agentId?:string}}>("/companies/:companyId/knowledge/memory/daily-notes",async(r,reply)=>{
    try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);const date=r.body.date??new Date().toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+"T00:00:00Z")))throw Error("date must be YYYY-MM-DD");if(!r.body.topic?.trim()||!r.body.content?.trim())throw Error("topic and content are required");const result=await repo.addDailyNote(c,r.params.companyId,{date,topic:r.body.topic,content:r.body.content,agentId:r.body.agentId,idempotencyKey:key(r)});return reply.code(result.created?201:200).send(result.note);}catch(e){return err(reply,e);}
  });
  app.get<{Params:{companyId:string};Querystring:{date?:string}}>("/companies/:companyId/knowledge/memory/daily-notes",async(r,reply)=>{
    try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);const date=r.query.date??new Date().toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error("date must be YYYY-MM-DD");return {date,notes:await repo.dailyNotes(c,r.params.companyId,date)};}catch(e){return err(reply,e);}
  });
  app.post<{Params:{companyId:string};Body:{title:string;description:string;triggerKeywords?:string[]}}>("/companies/:companyId/knowledge/memory/standing-intents",async(r,reply)=>{
    try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!r.body.title?.trim()||!r.body.description?.trim())throw Error("title and description are required");const keywords=[...new Set((r.body.triggerKeywords??[]).map(v=>v.trim().toLowerCase()).filter(Boolean))].slice(0,50);const result=await repo.addStandingIntent(c,r.params.companyId,{title:r.body.title,description:r.body.description,triggerKeywords:keywords,idempotencyKey:key(r)});return reply.code(result.created?201:200).send(result.intent);}catch(e){return err(reply,e);}
  });
  app.get<{Params:{companyId:string};Querystring:{status?:string;query?:string}}>("/companies/:companyId/knowledge/memory/standing-intents",async(r,reply)=>{
    try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);const allowedStatuses=["pending","in_progress","fulfilled","cancelled"];if(r.query.status&&!allowedStatuses.includes(r.query.status))throw Error("Invalid intent status");let intents:any[]=await repo.standingIntents(c,r.params.companyId,r.query.status);if(r.query.query?.trim()){const text=r.query.query.toLowerCase();intents=intents.filter(intent=>!["fulfilled","cancelled"].includes(intent.status)&&((intent.triggerKeywords as string[]).length===0||(intent.triggerKeywords as string[]).some(keyword=>text.includes(keyword.toLowerCase()))));}return {intents};}catch(e){return err(reply,e);}
  });
  app.patch<{Params:{companyId:string;intentId:string};Body:{status:string;expectedRevision:number}}>("/companies/:companyId/knowledge/memory/standing-intents/:intentId",async(r,reply)=>{
    try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!["pending","in_progress","fulfilled","cancelled"].includes(r.body.status)||!Number.isInteger(r.body.expectedRevision))throw Error("Valid status and expectedRevision are required");return await repo.updateStandingIntent(c,r.params.companyId,r.params.intentId,r.body.status,r.body.expectedRevision);}catch(e){return err(reply,e);}
  });  app.get<{Params:{companyId:string}}>("/companies/:companyId/knowledge/wiki",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);return {pages:await repo.wikiPages(c,r.params.companyId)};}catch(e){return err(reply,e);}});
  app.get<{Params:{companyId:string};Querystring:{path:string}}>("/companies/:companyId/knowledge/wiki/page",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);const path=normalizeWikiPath(r.query.path);const page=await repo.wikiPage(c,r.params.companyId,path);if(!page)throw Object.assign(Error("Wiki page not found"),{status:404});return page;}catch(e){return err(reply,e);}});
  app.get<{Params:{companyId:string};Querystring:{path:string}}>("/companies/:companyId/knowledge/wiki/backlinks",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);const path=normalizeWikiPath(r.query.path);return {path,backlinks:await repo.wikiBacklinks(c,r.params.companyId,path)};}catch(e){return err(reply,e);}});
  app.delete<{Params:{companyId:string};Body:{path:string;expectedRevision:number}}>("/companies/:companyId/knowledge/wiki",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);const path=normalizeWikiPath(r.body.path);if(!Number.isInteger(r.body.expectedRevision)||!await repo.deleteWikiPage(c,r.params.companyId,path,r.body.expectedRevision))throw Object.assign(Error("Wiki page changed or not found"),{status:409});return reply.code(204).send();}catch(e){return err(reply,e);}});  app.put<{Params:{companyId:string};Body:{path:string;title:string;content:string;tags?:string[];expectedRevision:number}}>("/companies/:companyId/knowledge/wiki",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!r.body.title?.trim()||!r.body.content?.trim()||!Number.isInteger(r.body.expectedRevision))throw Error("title, content and expectedRevision are required");const path=normalizeWikiPath(r.body.path),links=[...new Set([...r.body.content.matchAll(/\[\[([\p{L}\p{N}_\-/ ]+)\]\]/gu)].map(match=>normalizeWikiPath(match[1]!)))];return await repo.upsertWikiPage(c,r.params.companyId,{path,title:r.body.title.trim(),content:r.body.content,tags:[...new Set((r.body.tags??[]).map(tag=>tag.trim()).filter(Boolean))].slice(0,30),outboundLinks:links,expectedRevision:r.body.expectedRevision});}catch(e){return err(reply,e);}});
  app.post<{Params:{companyId:string}}>("/companies/:companyId/knowledge/memory/dream",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);const result=await repo.runDreamingCycle(c,r.params.companyId,key(r));return reply.code(result.created?201:200).send(result.result);}catch(e){return err(reply,e);}});
  app.post<{Params:{companyId:string};Body:{actionName:string;title:string;instruction:string;riskLevel?:string}}>("/companies/:companyId/knowledge/memory/action-rules",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);const actionName=r.body.actionName?.trim().toLocaleLowerCase();if(!actionName||!/^[a-z0-9._:-]{2,100}$/.test(actionName)||!r.body.title?.trim()||!r.body.instruction?.trim())throw Error("Valid actionName, title and instruction are required");const risk=r.body.riskLevel??"medium";if(!["low","medium","high"].includes(risk))throw Error("Invalid riskLevel");const result=await repo.addActionRule(c,r.params.companyId,{actionName,title:r.body.title.trim(),instruction:r.body.instruction.trim(),riskLevel:risk,idempotencyKey:key(r)});return reply.code(result.created?201:200).send(result.rule);}catch(e){return err(reply,e);}});
  app.get<{Params:{companyId:string};Querystring:{actions?:string}}>("/companies/:companyId/knowledge/memory/action-rules",async(r,reply)=>{try{const c=await ctx(auth,r,"workspace:read");await store.getCompany(c,r.params.companyId);const actions=(r.query.actions??"").split(",").map(v=>v.trim()).filter(Boolean);return {rules:await repo.actionRules(c,r.params.companyId,actions)};}catch(e){return err(reply,e);}});
  app.patch<{Params:{companyId:string;ruleId:string};Body:{title:string;instruction:string;riskLevel:string;expectedRevision:number}}>("/companies/:companyId/knowledge/memory/action-rules/:ruleId",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!r.body.title?.trim()||!r.body.instruction?.trim()||!["low","medium","high"].includes(r.body.riskLevel)||!Number.isInteger(r.body.expectedRevision))throw Error("Valid title, instruction, riskLevel and expectedRevision are required");return await repo.updateActionRule(c,r.params.companyId,r.params.ruleId,{title:r.body.title.trim(),instruction:r.body.instruction.trim(),riskLevel:r.body.riskLevel,expectedRevision:r.body.expectedRevision});}catch(e){return err(reply,e);}});  app.delete<{Params:{companyId:string;ruleId:string}}>("/companies/:companyId/knowledge/memory/action-rules/:ruleId",async(r,reply)=>{try{const c=await ctx(auth,r,"business:manage");await store.getCompany(c,r.params.companyId);if(!await repo.deleteActionRule(c,r.params.companyId,r.params.ruleId))throw Object.assign(Error("Action rule not found"),{status:404});return reply.code(204).send();}catch(e){return err(reply,e);}});  app.post<{Params:{companyId:string};Body:{query:string;limit?:number}}>("/companies/:companyId/knowledge/retrieve",async(r,reply)=>{
    try{
      const c=await ctx(auth,r,"workspace:read");
      await store.getCompany(c,r.params.companyId);
      const limit=Math.min(20,Math.max(1,r.body.limit??6));
      const context=await processor.retrieveContext(c,r.params.companyId,r.body.query,limit);
      return {chunks:context.chunks,memories:context.memories};
    }catch(e){return err(reply,e);}
  });
  app.post<{Params:{companyId:string};Body:{text?:string;messages?:Array<{role:string;content:string}>;noMemory?:boolean;persist?:boolean}}>("/companies/:companyId/knowledge/memory/extract",async(r,reply)=>{
    try{
      const c=await ctx(auth,r,"business:manage");
      await store.getCompany(c,r.params.companyId);
      const messages=r.body.messages&&r.body.messages.length>0
        ? r.body.messages
        : r.body.text
        ? [{role:"user",content:r.body.text}]
        : [];
      if(!messages.length)return reply.code(400).send({error:{code:"INPUT_REQUIRED",message:"text or messages array is required for extraction"}});
      const noMemory=r.body.noMemory===true||r.headers["x-no-memory"]==="true";
      const shouldPersist=r.body.persist!==false&&!noMemory;
      if(shouldPersist){
        const persisted=await AutomaticMemoryExtractor.autoExtractAndPersist({
          auth:c,
          companyId:r.params.companyId,
          repo,
          messages,
          noMemory,
        });
        return reply.code(200).send({persisted,count:persisted.length,noMemory});
      }
      const extracted=AutomaticMemoryExtractor.extractFacts(messages);
      return reply.code(200).send({extracted:noMemory?[]:extracted,count:noMemory?0:extracted.length,noMemory});
    }catch(e){return err(reply,e);}
  });
  app.post<{Params:{companyId:string};Body:{query:string;memories?:DecayingMemoryItem[];topK?:number;minFinalScore?:number}}>("/companies/:companyId/knowledge/memory/rerank",async(r,reply)=>{
    try{
      const c=await ctx(auth,r,"workspace:read");
      await store.getCompany(c,r.params.companyId);
      const query=r.body.query;
      if(!query||typeof query!=="string")return reply.code(400).send({error:{code:"QUERY_REQUIRED",message:"query string is required for memory rerank"}});
      let candidates:DecayingMemoryItem[]=[];
      if(Array.isArray(r.body.memories)&&r.body.memories.length>0){
        candidates=r.body.memories;
      }else{
        let existing=await repo.searchMemories(c,r.params.companyId,query,30);
        if(!existing.length){
          existing=await repo.memories(c,r.params.companyId);
        }
        candidates=existing.map((m)=>({
          id:m.id,
          type:(m.metadata?.type as MemoryDecayType)||(m.source==="ephemeral"?"ephemeral":m.source==="rule"?"project_rule":"operational"),
          title:(m.metadata?.title as string)||m.content.slice(0,40),
          content:m.content,
          baseWeight:typeof m.metadata?.weight==="number"?m.metadata.weight:1.0,
          createdAt:m.createdAt,
        }));
      }
      const result=MemoryRerankEngine.rerankMemories(query,candidates,{
        topK:r.body.topK??10,
        minFinalScore:r.body.minFinalScore??0.05,
      });
      return reply.code(200).send({query,rankedMemories:result.rankedMemories,totalEvaluated:result.totalEvaluated});
    }catch(e){return err(reply,e);}
  });
}

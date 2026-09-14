import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";
import * as fflate from "fflate";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ObjectStorage } from "./object-storage";
import { NPATI_BUCKETS, objectKey } from "./object-storage";
import type { FileMetadataRepository, StoredFile } from "./file-metadata";
import type { ProductionMemoryEngineRegistry } from "./knowledge-memory-engine";
import type { ParsedMemoryImport } from "./production-memory-import";
import { MemoryRerankEngine, TypedDecayMemoryManager, type DecayingMemoryItem, type MemoryDecayType } from "./advanced-memory-management";

export type KnowledgeStatus="uploaded"|"processing"|"ready"|"failed"|"deleted";
export interface KnowledgeDocument { id:string; workspaceId:string; companyId:string; userId:string; fileId:string; status:KnowledgeStatus; errorMessage?:string; chunkCount:number; embeddingModel?:string; attemptCount:number; createdAt:string; updatedAt:string; file?:StoredFile; filename?:string; sizeBytes?:number; mimeType?:string; }
export interface CompanyMemory { id:string;workspaceId:string;companyId:string;userId:string;content:string;source:string;metadata:Record<string,unknown>;revision:number;createdAt:string;updatedAt:string; }
export interface KnowledgeCandidate { id:string;content:string;score:number;vectorScore:number;keywordScore:number;rerankScore?:number; }
const docCols='d.id,d.workspace_id AS "workspaceId",d.company_id AS "companyId",d.user_id AS "userId",d.file_id AS "fileId",d.status,d.error_message AS "errorMessage",d.chunk_count AS "chunkCount",d.embedding_model AS "embeddingModel",d.attempt_count AS "attemptCount",d.created_at AS "createdAt",d.updated_at AS "updatedAt",f.original_filename AS "filename",f.size_bytes AS "sizeBytes",f.mime_type AS "mimeType"';
const docColsRaw='id,workspace_id AS "workspaceId",company_id AS "companyId",user_id AS "userId",file_id AS "fileId",status,error_message AS "errorMessage",chunk_count AS "chunkCount",embedding_model AS "embeddingModel",attempt_count AS "attemptCount",created_at AS "createdAt",updated_at AS "updatedAt"';
const memCols='id,workspace_id AS "workspaceId",company_id AS "companyId",user_id AS "userId",content,source,metadata,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
const vector=(values:number[])=>'['+values.map((n)=>Number.isFinite(n)?n:0).join(',')+']';

export class CompanyKnowledgeRepository {
 private pool:Pool;
 constructor(databaseUrl:string){this.pool=new Pool({connectionString:databaseUrl,max:5});}
 async create(ctx:AuthContext,companyId:string,fileId:string,key:string){const id=randomUUID();const r=await this.pool.query<KnowledgeDocument>(`INSERT INTO company_knowledge_documents(id,workspace_id,company_id,user_id,file_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING ${docColsRaw}`,[id,ctx.workspaceId,companyId,ctx.userId,fileId,key]);if(r.rows[0])return {document:await this.get(ctx,companyId,r.rows[0].id),created:true};const e=await this.pool.query<KnowledgeDocument>(`SELECT ${docColsRaw} FROM company_knowledge_documents WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4 AND deleted_at IS NULL`,[ctx.workspaceId,companyId,ctx.userId,key]);if(!e.rows[0])throw Error("Document create conflict");return {document:await this.get(ctx,companyId,e.rows[0].id),created:false};}
 async list(ctx:AuthContext,companyId:string,limit=50,cursor?:string){const r=await this.pool.query<KnowledgeDocument>(`SELECT ${docCols} FROM company_knowledge_documents d LEFT JOIN files f ON f.id=d.file_id WHERE d.workspace_id=$1 AND d.company_id=$2 AND d.user_id=$3 AND d.deleted_at IS NULL AND ($4::uuid IS NULL OR d.id<$4) ORDER BY d.id DESC LIMIT $5`,[ctx.workspaceId,companyId,ctx.userId,cursor??null,Math.min(100,Math.max(1,limit))]);return r.rows;}
 async get(ctx:AuthContext,companyId:string,id:string){const r=await this.pool.query<KnowledgeDocument>(`SELECT ${docCols} FROM company_knowledge_documents d LEFT JOIN files f ON f.id=d.file_id WHERE d.id=$1 AND d.workspace_id=$2 AND d.company_id=$3 AND d.user_id=$4 AND d.deleted_at IS NULL`,[id,ctx.workspaceId,companyId,ctx.userId]);if(!r.rows[0])throw Object.assign(Error("Knowledge document not found"),{status:404});return r.rows[0];}
 async claim(id:string,worker:string,leaseMs=180000){const r=await this.pool.query<KnowledgeDocument>(`UPDATE company_knowledge_documents SET status='processing',worker_id=$2,lease_expires_at=now()+($3||' milliseconds')::interval,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND status IN('uploaded','failed','processing') AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) AND attempt_count<max_attempts RETURNING ${docColsRaw}`,[id,worker,leaseMs]);return r.rows[0];}
 async complete(doc:KnowledgeDocument,chunks:Array<{content:string;hash:string;embedding:number[]}>,model:string){const client=await this.pool.connect();try{await client.query('BEGIN');const current=await client.query<{deleted_at:string|null}>('SELECT deleted_at FROM company_knowledge_documents WHERE id=$1 FOR UPDATE',[doc.id]);if(!current.rows[0]||current.rows[0].deleted_at){await client.query('ROLLBACK');return false;}await client.query('DELETE FROM company_knowledge_chunks WHERE document_id=$1',[doc.id]);for(let i=0;i<chunks.length;i++){const c=chunks[i]!;await client.query('INSERT INTO company_knowledge_chunks(id,workspace_id,company_id,document_id,chunk_index,content,content_hash,token_count,embedding,embedding_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10)',[randomUUID(),doc.workspaceId,doc.companyId,doc.id,i,c.content,c.hash,Math.ceil(c.content.length/4),vector(c.embedding),model]);}await client.query("UPDATE company_knowledge_documents SET status='ready',error_message=NULL,chunk_count=$2,embedding_model=$3,embedding_dimensions=$4,worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NULL",[doc.id,chunks.length,model,chunks[0]?.embedding.length??0]);await client.query('COMMIT');return true;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
 async fail(id:string,error:string){await this.pool.query("UPDATE company_knowledge_documents SET status='failed',error_message=$2,worker_id=NULL,lease_expires_at=NULL,next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND deleted_at IS NULL",[id,error.slice(0,1000)]);}
 async retry(ctx:AuthContext,companyId:string,id:string){await this.get(ctx,companyId,id);await this.pool.query("UPDATE company_knowledge_documents SET status='uploaded',error_message=NULL,attempt_count=0,next_attempt_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1",[id]);}
 async remove(ctx:AuthContext,companyId:string,id:string){const client=await this.pool.connect();try{await client.query("BEGIN");const found=await client.query<KnowledgeDocument&{deletedAt:string|null}>(`SELECT ${docColsRaw},deleted_at AS "deletedAt" FROM company_knowledge_documents WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 FOR UPDATE`,[id,ctx.workspaceId,companyId,ctx.userId]);const d=found.rows[0];if(!d)throw Object.assign(Error("Knowledge document not found"),{status:404});const alreadyDeleted=Boolean(d.deletedAt);if(!alreadyDeleted){await client.query("DELETE FROM company_knowledge_chunks WHERE document_id=$1 AND workspace_id=$2 AND company_id=$3",[id,ctx.workspaceId,companyId]);await client.query("UPDATE company_knowledge_documents SET status='deleted',chunk_count=0,worker_id=NULL,lease_expires_at=NULL,deleted_at=now(),updated_at=now() WHERE id=$1",[id]);}await client.query("COMMIT");return {document:d,alreadyDeleted};}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}}
 async recover(limit=100){return (await this.pool.query<{id:string}>("SELECT id FROM company_knowledge_documents WHERE deleted_at IS NULL AND attempt_count<max_attempts AND next_attempt_at<=now() AND (status IN('uploaded','failed') OR (status='processing' AND lease_expires_at<now())) ORDER BY next_attempt_at LIMIT $1",[limit])).rows.map(r=>r.id);}
 async candidates(ctx:AuthContext,companyId:string,embedding:number[],limit=20){return (await this.pool.query<{content:string;score:number}>(`SELECT c.content,1-(c.embedding<=>$4::vector) AS score FROM company_knowledge_chunks c JOIN company_knowledge_documents d ON d.id=c.document_id WHERE c.workspace_id=$1 AND c.company_id=$2 AND d.user_id=$3 AND d.status='ready' AND d.deleted_at IS NULL AND vector_dims(c.embedding)=vector_dims($4::vector) ORDER BY c.embedding<=>$4::vector LIMIT $5`,[ctx.workspaceId,companyId,ctx.userId,vector(embedding),limit])).rows;}
 async hybridCandidates(ctx:AuthContext,companyId:string,query:string,embedding:number[]|undefined,limit=20):Promise<KnowledgeCandidate[]>{
  const bounded=Math.min(100,Math.max(1,limit));
  const vectorHits=embedding?.length?(await this.pool.query<{id:string;content:string;score:number}>(`SELECT c.id,c.content,1-(c.embedding<=>$4::vector) AS score FROM company_knowledge_chunks c JOIN company_knowledge_documents d ON d.id=c.document_id WHERE c.workspace_id=$1 AND c.company_id=$2 AND d.user_id=$3 AND d.status='ready' AND d.deleted_at IS NULL AND c.embedding IS NOT NULL AND vector_dims(c.embedding)=vector_dims($4::vector) ORDER BY c.embedding<=>$4::vector LIMIT $5`,[ctx.workspaceId,companyId,ctx.userId,vector(embedding),bounded])).rows:[];
  const keywordHits=(await this.pool.query<{id:string;content:string;score:number}>(`WITH q AS (SELECT websearch_to_tsquery('simple',$4) AS value) SELECT c.id,c.content,ts_rank_cd(to_tsvector('simple',c.content),q.value) AS score FROM company_knowledge_chunks c JOIN company_knowledge_documents d ON d.id=c.document_id CROSS JOIN q WHERE c.workspace_id=$1 AND c.company_id=$2 AND d.user_id=$3 AND d.status='ready' AND d.deleted_at IS NULL AND q.value @@ to_tsvector('simple',c.content) ORDER BY score DESC,c.id LIMIT $5`,[ctx.workspaceId,companyId,ctx.userId,query.trim(),bounded])).rows;
  const merged=new Map<string,KnowledgeCandidate>();
  const include=(item:{id:string;content:string;score:number},rank:number,kind:"vector"|"keyword")=>{const current=merged.get(item.id)??{id:item.id,content:item.content,score:0,vectorScore:0,keywordScore:0};current.score+=1/(60+rank);if(kind==="vector")current.vectorScore=Number(item.score);else current.keywordScore=Number(item.score);merged.set(item.id,current);};
  vectorHits.forEach((item,index)=>include(item,index+1,"vector"));
  keywordHits.forEach((item,index)=>include(item,index+1,"keyword"));
  return [...merged.values()].sort((a,b)=>b.score-a.score||b.keywordScore-a.keywordScore||b.vectorScore-a.vectorScore).slice(0,bounded);
 }
 async memories(ctx:AuthContext,companyId:string){return (await this.pool.query<CompanyMemory>(`SELECT ${memCols} FROM company_memories WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`,[ctx.workspaceId,companyId,ctx.userId])).rows;}
 async getMemory(ctx:AuthContext,companyId:string,id:string){const r=await this.pool.query<CompanyMemory>(`SELECT ${memCols} FROM company_memories WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND deleted_at IS NULL`,[id,ctx.workspaceId,companyId,ctx.userId]);if(!r.rows[0])throw Object.assign(Error("Company memory not found"),{status:404});return r.rows[0];}
 async searchMemories(ctx:AuthContext,companyId:string,query:string,limit=20){return (await this.pool.query<CompanyMemory>(`WITH q AS (SELECT websearch_to_tsquery('simple',$4) AS value) SELECT ${memCols},ts_rank_cd(to_tsvector('simple',content),q.value) AS relevance FROM company_memories CROSS JOIN q WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND deleted_at IS NULL AND (q.value @@ to_tsvector('simple',content) OR content ILIKE '%'||$4||'%') ORDER BY relevance DESC,updated_at DESC LIMIT $5`,[ctx.workspaceId,companyId,ctx.userId,query.trim(),Math.min(100,Math.max(1,limit))])).rows;}
 async addMemory(ctx:AuthContext,companyId:string,content:string,source='manual',metadata:Record<string,unknown>={}){return (await this.pool.query<CompanyMemory>(`INSERT INTO company_memories(id,workspace_id,company_id,user_id,content,source,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${memCols}`,[randomUUID(),ctx.workspaceId,companyId,ctx.userId,content.trim(),source,JSON.stringify(metadata)])).rows[0]!;}
 async updateMemory(ctx:AuthContext,companyId:string,id:string,content:string){const r=await this.pool.query<CompanyMemory>(`UPDATE company_memories SET content=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND deleted_at IS NULL RETURNING ${memCols}`,[id,ctx.workspaceId,companyId,ctx.userId,content.trim()]);if(!r.rows[0])throw Object.assign(Error("Company memory not found"),{status:404});return r.rows[0];}
 async deleteMemory(ctx:AuthContext,companyId:string,id:string){const r=await this.pool.query("UPDATE company_memories SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND deleted_at IS NULL",[id,ctx.workspaceId,companyId,ctx.userId]);return Boolean(r.rowCount);}
 async addMemoryIdempotent(ctx:AuthContext,companyId:string,content:string,source:string,requestKey:string,metadata:Record<string,unknown>={}){
  const id=randomUUID();
  const inserted=await this.pool.query<CompanyMemory>(`INSERT INTO company_memories(id,workspace_id,company_id,user_id,content,source,metadata,request_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING ${memCols}`,[id,ctx.workspaceId,companyId,ctx.userId,content.trim(),source,JSON.stringify(metadata),requestKey]);
  if(inserted.rows[0])return {memory:inserted.rows[0],created:true};
  const existing=await this.pool.query<CompanyMemory>(`SELECT ${memCols} FROM company_memories WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND source=$4 AND request_key=$5 AND deleted_at IS NULL`,[ctx.workspaceId,companyId,ctx.userId,source,requestKey]);
  if(!existing.rows[0])throw Error("Memory idempotency conflict");
  return {memory:existing.rows[0],created:false};
 }
 async addDailyNote(ctx:AuthContext,companyId:string,input:{date:string;topic:string;content:string;agentId?:string;idempotencyKey:string}){
  const id=randomUUID();
  const inserted=await this.pool.query(`INSERT INTO company_daily_memory_notes(id,workspace_id,company_id,user_id,note_date,topic,content,agent_id,idempotency_key) VALUES($1,$2,$3,$4,$5::date,$6,$7,$8::uuid,$9) ON CONFLICT DO NOTHING RETURNING id,company_id AS "companyId",note_date::text AS date,topic,content,agent_id AS "agentId",created_at AS "createdAt"`,[id,ctx.workspaceId,companyId,ctx.userId,input.date,input.topic.trim(),input.content.trim(),input.agentId??null,input.idempotencyKey]);
  if(inserted.rows[0])return {note:inserted.rows[0],created:true};
  const existing=await this.pool.query(`SELECT id,company_id AS "companyId",note_date::text AS date,topic,content,agent_id AS "agentId",created_at AS "createdAt" FROM company_daily_memory_notes WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,[ctx.workspaceId,companyId,ctx.userId,input.idempotencyKey]);
  if(!existing.rows[0])throw Error("Daily note idempotency conflict");
  return {note:existing.rows[0],created:false};
 }
 async dailyNotes(ctx:AuthContext,companyId:string,date:string){return (await this.pool.query(`SELECT id,company_id AS "companyId",note_date::text AS date,topic,content,agent_id AS "agentId",created_at AS "createdAt" FROM company_daily_memory_notes WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND note_date=$4::date ORDER BY created_at,id`,[ctx.workspaceId,companyId,ctx.userId,date])).rows;}
 async addStandingIntent(ctx:AuthContext,companyId:string,input:{title:string;description:string;triggerKeywords:string[];idempotencyKey:string}){
  const id=randomUUID();
  const inserted=await this.pool.query(`INSERT INTO company_standing_intents(id,workspace_id,company_id,user_id,title,description,trigger_keywords,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING id,company_id AS "companyId",title,description,status,trigger_keywords AS "triggerKeywords",revision,created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt"`,[id,ctx.workspaceId,companyId,ctx.userId,input.title.trim(),input.description.trim(),JSON.stringify(input.triggerKeywords),input.idempotencyKey]);
  if(inserted.rows[0])return {intent:inserted.rows[0],created:true};
  const existing=await this.pool.query(`SELECT id,company_id AS "companyId",title,description,status,trigger_keywords AS "triggerKeywords",revision,created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt" FROM company_standing_intents WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,[ctx.workspaceId,companyId,ctx.userId,input.idempotencyKey]);
  if(!existing.rows[0])throw Error("Standing intent idempotency conflict");
  return {intent:existing.rows[0],created:false};
 }
 async standingIntents(ctx:AuthContext,companyId:string,status?:string){return (await this.pool.query(`SELECT id,company_id AS "companyId",title,description,status,trigger_keywords AS "triggerKeywords",revision,created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt" FROM company_standing_intents WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND ($4::text IS NULL OR status=$4) ORDER BY updated_at DESC,id`,[ctx.workspaceId,companyId,ctx.userId,status??null])).rows;}
 async updateStandingIntent(ctx:AuthContext,companyId:string,id:string,status:string,expectedRevision:number){const result=await this.pool.query(`UPDATE company_standing_intents SET status=$5,revision=revision+1,updated_at=now(),resolved_at=CASE WHEN $5 IN ('fulfilled','cancelled') THEN now() ELSE NULL END WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND revision=$6 RETURNING id,company_id AS "companyId",title,description,status,trigger_keywords AS "triggerKeywords",revision,created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt"`,[id,ctx.workspaceId,companyId,ctx.userId,status,expectedRevision]);if(!result.rows[0])throw Object.assign(Error("Standing intent was changed or not found"),{status:409});return result.rows[0];} async wikiPages(ctx:AuthContext,companyId:string){return (await this.pool.query(`SELECT id,company_id AS "companyId",path,title,content,tags,outbound_links AS "outboundLinks",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM company_memory_wiki_pages WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 ORDER BY path`,[ctx.workspaceId,companyId,ctx.userId])).rows;}
 async wikiPage(ctx:AuthContext,companyId:string,path:string){return (await this.pool.query(`SELECT id,company_id AS "companyId",path,title,content,tags,outbound_links AS "outboundLinks",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM company_memory_wiki_pages WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND path=$4`,[ctx.workspaceId,companyId,ctx.userId,path])).rows[0]??null;}
 async upsertWikiPage(ctx:AuthContext,companyId:string,input:{path:string;title:string;content:string;tags:string[];outboundLinks:string[];expectedRevision:number}){const existing=await this.wikiPage(ctx,companyId,input.path);if(!existing&&input.expectedRevision===0)return (await this.pool.query(`INSERT INTO company_memory_wiki_pages(id,workspace_id,company_id,user_id,path,title,content,tags,outbound_links) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id,company_id AS "companyId",path,title,content,tags,outbound_links AS "outboundLinks",revision,created_at AS "createdAt",updated_at AS "updatedAt"`,[randomUUID(),ctx.workspaceId,companyId,ctx.userId,input.path,input.title,input.content,JSON.stringify(input.tags),JSON.stringify(input.outboundLinks)])).rows[0]??(()=>{throw Object.assign(Error("Wiki page changed concurrently"),{status:409});})();if(!existing||Number((existing as any).revision)!==input.expectedRevision)throw Object.assign(Error("Wiki page revision conflict"),{status:409});const result=await this.pool.query(`UPDATE company_memory_wiki_pages SET title=$5,content=$6,tags=$7::jsonb,outbound_links=$8::jsonb,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND path=$4 AND revision=$9 RETURNING id,company_id AS "companyId",path,title,content,tags,outbound_links AS "outboundLinks",revision,created_at AS "createdAt",updated_at AS "updatedAt"`,[ctx.workspaceId,companyId,ctx.userId,input.path,input.title,input.content,JSON.stringify(input.tags),JSON.stringify(input.outboundLinks),input.expectedRevision]);if(!result.rows[0])throw Object.assign(Error("Wiki page revision conflict"),{status:409});return result.rows[0];}
 async wikiBacklinks(ctx:AuthContext,companyId:string,path:string){return (await this.pool.query(`SELECT path,title FROM company_memory_wiki_pages WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND outbound_links ? $4 ORDER BY path`,[ctx.workspaceId,companyId,ctx.userId,path])).rows;}
 async deleteWikiPage(ctx:AuthContext,companyId:string,path:string,expectedRevision:number){return Boolean((await this.pool.query(`DELETE FROM company_memory_wiki_pages WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND path=$4 AND revision=$5`,[ctx.workspaceId,companyId,ctx.userId,path,expectedRevision])).rowCount);} async runDreamingCycle(ctx:AuthContext,companyId:string,idempotencyKey:string){const old=await this.pool.query(`SELECT result FROM company_dreaming_cycles WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,[ctx.workspaceId,companyId,ctx.userId,idempotencyKey]);if(old.rows[0])return {result:old.rows[0].result,created:false};const memories=await this.memories(ctx,companyId);const unique=new Map<string,CompanyMemory>();let pruned=0;for(const memory of memories){const type=(memory.metadata?.type as MemoryDecayType)??"operational";const weight=TypedDecayMemoryManager.calculateEffectiveWeight({id:memory.id,type,title:String(memory.metadata?.title??memory.content.slice(0,40)),content:memory.content,baseWeight:typeof memory.metadata?.weight==="number"?memory.metadata.weight:1,createdAt:memory.createdAt});if(weight<0.05){pruned++;continue;}const key=memory.content.trim().toLocaleLowerCase();if(!unique.has(key))unique.set(key,memory);}const result={consolidatedFactsCount:unique.size,prunedDecayedCount:pruned,resolvedContradictions:0,synthesizedWikiPages:unique.size?["consolidated/dreaming-summary"]:[],cycleTimestamp:new Date().toISOString()};if(unique.size){const content=["# Consolidated Company Knowledge","",...[...unique.values()].map(memory=>`- ${memory.content}`)].join("\n");const page=await this.wikiPage(ctx,companyId,"consolidated/dreaming-summary");await this.upsertWikiPage(ctx,companyId,{path:"consolidated/dreaming-summary",title:"Consolidated Company Knowledge",content,tags:["dreaming","auto-consolidated"],outboundLinks:[],expectedRevision:Number((page as any)?.revision??0)});}const inserted=await this.pool.query(`INSERT INTO company_dreaming_cycles(id,workspace_id,company_id,user_id,idempotency_key,status,result) VALUES($1,$2,$3,$4,$5,'completed',$6::jsonb) ON CONFLICT DO NOTHING RETURNING result`,[randomUUID(),ctx.workspaceId,companyId,ctx.userId,idempotencyKey,JSON.stringify(result)]);if(inserted.rows[0])return {result:inserted.rows[0].result,created:true};const concurrent=await this.pool.query(`SELECT result FROM company_dreaming_cycles WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,[ctx.workspaceId,companyId,ctx.userId,idempotencyKey]);return {result:concurrent.rows[0].result,created:false};}
 async addActionRule(ctx:AuthContext,companyId:string,input:{actionName:string;title:string;instruction:string;riskLevel:string;idempotencyKey:string}){const inserted=await this.pool.query(`INSERT INTO company_action_memory_rules(id,workspace_id,company_id,user_id,action_name,title,instruction,risk_level,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id,company_id AS "companyId",action_name AS "actionName",title,instruction,risk_level AS "riskLevel",revision,created_at AS "createdAt",updated_at AS "updatedAt"`,[randomUUID(),ctx.workspaceId,companyId,ctx.userId,input.actionName,input.title,input.instruction,input.riskLevel,input.idempotencyKey]);if(inserted.rows[0])return {rule:inserted.rows[0],created:true};const existing=await this.pool.query(`SELECT id,company_id AS "companyId",action_name AS "actionName",title,instruction,risk_level AS "riskLevel",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM company_action_memory_rules WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4 AND deleted_at IS NULL`,[ctx.workspaceId,companyId,ctx.userId,input.idempotencyKey]);return {rule:existing.rows[0],created:false};}
 async actionRules(ctx:AuthContext,companyId:string,actions:string[]=[]){const rules=(await this.pool.query(`SELECT id,company_id AS "companyId",action_name AS "actionName",title,instruction,risk_level AS "riskLevel",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM company_action_memory_rules WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND deleted_at IS NULL ORDER BY updated_at DESC`,[ctx.workspaceId,companyId,ctx.userId])).rows;const normalized=actions.map(value=>value.toLocaleLowerCase());return normalized.length?rules.filter((rule:any)=>normalized.some(action=>action.includes(rule.actionName)||rule.actionName.includes(action))):rules;}
 async updateActionRule(ctx:AuthContext,companyId:string,id:string,input:{title:string;instruction:string;riskLevel:string;expectedRevision:number}){const result=await this.pool.query(`UPDATE company_action_memory_rules SET title=$5,instruction=$6,risk_level=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND revision=$8 AND deleted_at IS NULL RETURNING id,company_id AS "companyId",action_name AS "actionName",title,instruction,risk_level AS "riskLevel",revision,created_at AS "createdAt",updated_at AS "updatedAt"`,[id,ctx.workspaceId,companyId,ctx.userId,input.title,input.instruction,input.riskLevel,input.expectedRevision]);if(!result.rows[0])throw Object.assign(Error("Action rule revision conflict"),{status:409});return result.rows[0];}
 async previewMemoryImport(ctx:AuthContext,companyId:string,items:ParsedMemoryImport[]){const unique=new Map(items.map(item=>[item.hash,item]));const hashes=[...unique.keys()];const existing=hashes.length?(await this.pool.query<{import_hash:string}>("SELECT import_hash FROM company_memories WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND import_hash=ANY($4::text[]) AND deleted_at IS NULL",[ctx.workspaceId,companyId,ctx.userId,hashes])).rows.map(row=>row.import_hash):[];const duplicates=new Set(existing);return{total:items.length,unique:unique.size,importable:[...unique.values()].filter(item=>!duplicates.has(item.hash)),duplicateCount:items.length-unique.size+duplicates.size}}
 async importMemoryBatch(ctx:AuthContext,companyId:string,input:{items:ParsedMemoryImport[];format:string;sourceName:string;idempotencyKey:string}){const client=await this.pool.connect();try{await client.query("BEGIN");const prior=await client.query("SELECT id,imported_count AS \"importedCount\",duplicate_count AS \"duplicateCount\",status,created_at AS \"createdAt\" FROM company_memory_import_batches WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4",[ctx.workspaceId,companyId,ctx.userId,input.idempotencyKey]);if(prior.rows[0]){await client.query("COMMIT");return{batch:prior.rows[0],created:false}}const unique=new Map(input.items.map(item=>[item.hash,item])),hashes=[...unique.keys()];const existing=hashes.length?(await client.query<{import_hash:string}>("SELECT import_hash FROM company_memories WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND import_hash=ANY($4::text[]) AND deleted_at IS NULL",[ctx.workspaceId,companyId,ctx.userId,hashes])).rows.map(row=>row.import_hash):[],duplicates=new Set(existing),importable=[...unique.values()].filter(item=>!duplicates.has(item.hash)),batchId=randomUUID(),duplicateCount=input.items.length-importable.length;await client.query("INSERT INTO company_memory_import_batches(id,workspace_id,company_id,user_id,idempotency_key,format,source_name,imported_count,duplicate_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[batchId,ctx.workspaceId,companyId,ctx.userId,input.idempotencyKey,input.format,input.sourceName,importable.length,duplicateCount]);for(const item of importable)await client.query("INSERT INTO company_memories(id,workspace_id,company_id,user_id,content,source,metadata,import_hash,import_batch_id) VALUES($1,$2,$3,$4,$5,'memory_import',$6::jsonb,$7,$8)",[randomUUID(),ctx.workspaceId,companyId,ctx.userId,item.content,JSON.stringify({author:item.author,sourceName:input.sourceName,timestamp:item.timestamp??null,provenance:item.provenance}),item.hash,batchId]);await client.query("COMMIT");return{batch:{id:batchId,importedCount:importable.length,duplicateCount,status:"completed"},created:true}}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
 async memoryImportBatches(ctx:AuthContext,companyId:string){return(await this.pool.query("SELECT id,format,source_name AS \"sourceName\",imported_count AS \"importedCount\",duplicate_count AS \"duplicateCount\",status,created_at AS \"createdAt\",rolled_back_at AS \"rolledBackAt\" FROM company_memory_import_batches WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 ORDER BY created_at DESC",[ctx.workspaceId,companyId,ctx.userId])).rows}
 async rollbackMemoryImport(ctx:AuthContext,companyId:string,batchId:string){const client=await this.pool.connect();try{await client.query("BEGIN");const batch=await client.query("SELECT status FROM company_memory_import_batches WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 FOR UPDATE",[batchId,ctx.workspaceId,companyId,ctx.userId]);if(!batch.rows[0])throw Object.assign(Error("Memory import batch not found"),{status:404});if(batch.rows[0].status!=="rolled_back"){await client.query("UPDATE company_memories SET deleted_at=now(),updated_at=now() WHERE import_batch_id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND deleted_at IS NULL",[batchId,ctx.workspaceId,companyId,ctx.userId]);await client.query("UPDATE company_memory_import_batches SET status='rolled_back',rolled_back_at=now() WHERE id=$1",[batchId])}await client.query("COMMIT");return{rolledBack:true}}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
 async deleteActionRule(ctx:AuthContext,companyId:string,id:string){return Boolean((await this.pool.query(`UPDATE company_action_memory_rules SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND deleted_at IS NULL`,[id,ctx.workspaceId,companyId,ctx.userId])).rowCount);} async purgeCompany(ctx:AuthContext,companyId:string){const client=await this.pool.connect();try{await client.query("BEGIN");await client.query("DELETE FROM company_knowledge_documents WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3",[ctx.workspaceId,companyId,ctx.userId]);await client.query("DELETE FROM company_memories WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3",[ctx.workspaceId,companyId,ctx.userId]);await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}}
 async close(){await this.pool.end();}
}

async function buffer(stream:NodeJS.ReadableStream){const parts:Buffer[]=[];for await(const part of stream as AsyncIterable<Buffer|string>)parts.push(Buffer.isBuffer(part)?part:Buffer.from(part));return Buffer.concat(parts);}
async function textOf(data:Buffer,mime:string){
 if(mime==='application/pdf'){const p=new PDFParse({data});try{return (await p.getText()).text;}finally{await p.destroy();}}
 if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document')return (await mammoth.extractRawText({buffer:data})).value;
 if(mime==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'||mime==='application/vnd.ms-excel'||mime==='application/x-msexcel'||mime==='application/x-excel'){
  let target:Buffer=data;
  try{
   const unzipped=fflate.unzipSync(new Uint8Array(data));
   let hasBackslash=false;
   const fixed:Record<string,Uint8Array>={};
   for(const [k,v] of Object.entries(unzipped)){
    if(k.includes('\\'))hasBackslash=true;
    fixed[k.replace(/\\/g,'/')]=v;
   }
   if(hasBackslash)target=Buffer.from(fflate.zipSync(fixed));
  }catch{}
  const sheets=await readXlsxFile(target);
  return sheets.map(sheet=>'[Sheet: '+sheet.sheet+']\n'+sheet.data.map(row=>row.map(cell=>cell==null?'':cell instanceof Date?cell.toISOString():String(cell)).join('\t')).join('\n')).join('\n\n');
 }
 if(mime.startsWith('text/')||mime==='application/json'||mime==='application/xml')return data.toString('utf8');
 throw Error('This document type can be stored but is not supported for knowledge extraction');
}
function chunks(text:string,size=1800,overlap=200){const clean=text.replace(/\0/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();const out:string[]=[];for(let at=0;at<clean.length;at+=size-overlap){const part=clean.slice(at,at+size).trim();if(part)out.push(part);if(at+size>=clean.length)break;}return out.slice(0,2000);}

function hashUuid(hash:string){return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export class CompanyKnowledgeProcessor {
 constructor(private repo:CompanyKnowledgeRepository,private files:FileMetadataRepository,private storage:ObjectStorage,private ai:AIEngine,private engines?:ProductionMemoryEngineRegistry){}
 async process(id:string,worker='knowledge-worker'){
  const doc=await this.repo.claim(id,worker);if(!doc)return;
  try{
   if(!this.ai.embed)throw Error('NPATI embeddings are unavailable');
   const file=await this.files.get(doc.fileId);
   if(!file||file.workspaceId!==doc.workspaceId||file.companyId!==doc.companyId||file.status!=='ready')throw Error('Knowledge file is unavailable or outside company scope');
   const raw=await buffer(await this.storage.get(file.bucket,file.objectKey));
   const parts=chunks(await textOf(raw,file.mimeType));
   if(!parts.length)throw Error('Document contains no extractable text');
   const vectors:number[][]=[];
   let embeddingModel="";
   for(let i=0;i<parts.length;i+=32){
    const batch=parts.slice(i,i+32);
    const embedded=await this.ai.embed({input:batch,timeoutMs:120000});
    vectors.push(...embedded.vectors);
    embeddingModel=embedded.model;
   }
   const storedChunks=parts.map((content,i)=>({content,hash:createHash('sha256').update(content).digest('hex'),embedding:vectors[i]!}));
   if(this.engines)await this.engines.upsert({workspaceId:doc.workspaceId,companyId:doc.companyId,userId:doc.userId},storedChunks.map((chunk,index)=>({id:hashUuid(createHash("sha256").update(`${doc.workspaceId}:${doc.companyId}:${doc.id}:${chunk.hash}`).digest("hex")),documentId:doc.id,vector:chunk.embedding,content:chunk.content,index})));
   await this.repo.complete(doc,storedChunks,embeddingModel);
  }catch(e){await this.repo.fail(id,e instanceof Error?e.message:String(e));throw e;}
 }
  async deleteDocumentVectors(doc:KnowledgeDocument){if(this.engines)await this.engines.deleteDocument({workspaceId:doc.workspaceId,companyId:doc.companyId,userId:doc.userId,documentId:doc.id});}
  async memoryEngineStatus(){return {engines:this.engines?.names()??["postgresql-pgvector"],health:this.engines?await this.engines.health():[]};}
  async retrieve(ctx:AuthContext,companyId:string,query:string,limit=6){
    let embedding:number[]|undefined;
    if(this.ai.embed)try{embedding=(await this.ai.embed({input:[query]})).vectors[0];}catch{embedding=undefined;}
    const candidates=await this.repo.hybridCandidates(ctx,companyId,query,embedding,Math.max(limit*4,12));
    if(this.engines){const hits=await this.engines.search({workspaceId:ctx.workspaceId,companyId,userId:ctx.userId},query,embedding,Math.max(limit*4,12));const seen=new Set(candidates.map(item=>item.content));for(const hit of hits)if(hit.content&&!seen.has(hit.content)){candidates.push({id:hit.id,content:hit.content,score:hit.score,vectorScore:hit.engine.startsWith("qdrant")?hit.score:0,keywordScore:hit.engine==="sqlite-fts5"?hit.score:0});seen.add(hit.content)}}
    if(!candidates.length)return[];
    if(this.ai.rerank){
      try{
        const ranked=await this.ai.rerank({query,documents:candidates.map(c=>c.content),topN:limit});
        return ranked.results.map(r=>{
          const item=candidates[r.index];
          if(item)item.rerankScore=r.relevanceScore;
          return item;
        }).filter((item): item is KnowledgeCandidate=>Boolean(item));
      }catch{
        // Hybrid SQL ranking remains available, but it must not be reported as cross-encoder reranking.
      }
    }
    return candidates.slice(0,limit);
  }
  async retrieveContext(ctx:AuthContext,companyId:string,query:string,limit=6){
    let [chunks,rawMemories,dailyNotes,standingIntents,wikiPages,actionRules]=await Promise.all([
      this.retrieve(ctx,companyId,query,limit),
      this.repo.searchMemories(ctx,companyId,query,Math.max(limit*2,12)),
      typeof (this.repo as any).dailyNotes==="function"?this.repo.dailyNotes(ctx,companyId,new Date().toISOString().slice(0,10)):Promise.resolve([]),
      typeof (this.repo as any).standingIntents==="function"?this.repo.standingIntents(ctx,companyId):Promise.resolve([]),
      typeof (this.repo as any).wikiPages==="function"?this.repo.wikiPages(ctx,companyId):Promise.resolve([]),
      typeof (this.repo as any).actionRules==="function"?this.repo.actionRules(ctx,companyId,query.split(/\s+/)):Promise.resolve([])
    ]);
    if(!rawMemories.length){
      rawMemories=await this.repo.memories(ctx,companyId);
    }
    const queryLower=query.toLocaleLowerCase();
    const structuredMemories:CompanyMemory[]=[
      ...dailyNotes.map((note:any)=>({id:note.id,workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,content:`${note.topic}: ${note.content}`,source:"daily_note",metadata:{type:"operational",title:note.topic,date:note.date,agentId:note.agentId},revision:1,createdAt:String(note.createdAt),updatedAt:String(note.createdAt)})),
      ...standingIntents.filter((intent:any)=>!["fulfilled","cancelled"].includes(intent.status)&&((intent.triggerKeywords as string[]).length===0||(intent.triggerKeywords as string[]).some(keyword=>queryLower.includes(keyword.toLocaleLowerCase())))).map((intent:any)=>({id:intent.id,workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,content:`Standing intent: ${intent.title}. ${intent.description}`,source:"standing_intent",metadata:{type:"project_rule",title:intent.title,status:intent.status,triggerKeywords:intent.triggerKeywords},revision:intent.revision,createdAt:String(intent.createdAt),updatedAt:String(intent.updatedAt)})),
      ...wikiPages.filter((page:any)=>queryLower.split(/\s+/).some(term=>term.length>2&&(page.title+" "+page.content+" "+page.tags.join(" ")).toLocaleLowerCase().includes(term))).map((page:any)=>({id:page.id,workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,content:`Wiki ${page.path}: ${page.title}\n${page.content}`,source:"memory_wiki",metadata:{type:"project_rule",title:page.title,path:page.path,tags:page.tags},revision:page.revision,createdAt:String(page.createdAt),updatedAt:String(page.updatedAt)})),
      ...actionRules.map((rule:any)=>({id:rule.id,workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,content:`Action rule [${rule.actionName}] ${rule.title}: ${rule.instruction}`,source:"action_sensitive",metadata:{type:"immutable",title:rule.title,actionName:rule.actionName,riskLevel:rule.riskLevel},revision:rule.revision,createdAt:String(rule.createdAt),updatedAt:String(rule.updatedAt)}))
    ];
    const existingIds=new Set(rawMemories.map(memory=>memory.id));
    rawMemories=[...rawMemories,...structuredMemories.filter(memory=>!existingIds.has(memory.id))];
    const decayingItems:DecayingMemoryItem[]=rawMemories.map(m=>({
      id:m.id,
      type:(m.metadata?.type as MemoryDecayType)||(m.source==="ephemeral"?"ephemeral":m.source==="rule"?"project_rule":"operational"),
      title:(m.metadata?.title as string)||m.content.slice(0,40),
      content:m.content,
      baseWeight:typeof m.metadata?.weight==="number"?m.metadata.weight:1.0,
      createdAt:m.createdAt??new Date().toISOString(),
    }));
    const reranked=MemoryRerankEngine.rerankMemories(query,decayingItems,{topK:limit});
    const memMap=new Map(rawMemories.map(m=>[m.id,m]));
    const memories=reranked.rankedMemories.map(rm=>{
      const original=memMap.get(rm.id);
      return {
        ...(original??{id:rm.id,workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,content:rm.content,source:"manual",metadata:{},revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}),
        rerankScore:rm.rerankScore,
        effectiveWeight:rm.effectiveWeight,
        finalScore:rm.finalScore,
        rank:rm.rank,
      };
    });
    return {chunks,memories};
  }
}

import { createRequire } from "node:module";
import type { ProductionQdrantClient } from "./qdrant-client";

const require = createRequire(import.meta.url);
export interface KnowledgeEngineScope{workspaceId:string;companyId:string;userId:string}
export interface KnowledgeEnginePoint{id:string;documentId:string;content:string;index:number;vector?:number[]}
export interface KnowledgeEngineHit{id:string;content:string;score:number;engine:string}
export interface KnowledgeMemoryEngine{readonly name:string;health():Promise<{healthy:boolean;detail?:string}>;upsert(scope:KnowledgeEngineScope,points:KnowledgeEnginePoint[]):Promise<void>;search(scope:KnowledgeEngineScope,query:{text:string;vector?:number[];limit:number}):Promise<KnowledgeEngineHit[]>;deleteDocument(scope:KnowledgeEngineScope&{documentId:string}):Promise<void>}
function ftsQuery(value:string){const terms=value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)??[];return [...new Set(terms)].slice(0,24).map(term=>`"${term.replaceAll('"','""')}"*`).join(" OR ")}
export class SqliteFts5MemoryEngine implements KnowledgeMemoryEngine{
 readonly name="sqlite-fts5";private readonly db: any;
 constructor(filename:string){const Database=require("better-sqlite3");this.db=new Database(filename);this.db.pragma("journal_mode = WAL");this.db.pragma("busy_timeout = 5000");this.db.exec(`
 CREATE TABLE IF NOT EXISTS knowledge_fts_documents(rowid INTEGER PRIMARY KEY,point_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,company_id TEXT NOT NULL,user_id TEXT NOT NULL,document_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,content TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS knowledge_fts_scope_idx ON knowledge_fts_documents(workspace_id,company_id,user_id,document_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(content,content='knowledge_fts_documents',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
 CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge_fts_documents BEGIN INSERT INTO knowledge_fts(rowid,content) VALUES(new.rowid,new.content);END;
 CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge_fts_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,content) VALUES('delete',old.rowid,old.content);END;
 CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge_fts_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,content) VALUES('delete',old.rowid,old.content);INSERT INTO knowledge_fts(rowid,content) VALUES(new.rowid,new.content);END;`);
 const available=this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as{enabled:number};if(available.enabled!==1)throw Error("The installed SQLite runtime does not include FTS5")}
 async health(){try{this.db.prepare("SELECT count(*) AS count FROM knowledge_fts").get();return{healthy:true}}catch(error){return{healthy:false,detail:error instanceof Error?error.message:String(error)}}}
 async upsert(scope:KnowledgeEngineScope,points:KnowledgeEnginePoint[]){const statement=this.db.prepare(`INSERT INTO knowledge_fts_documents(point_id,workspace_id,company_id,user_id,document_id,chunk_index,content) VALUES(@id,@workspaceId,@companyId,@userId,@documentId,@index,@content) ON CONFLICT(point_id) DO UPDATE SET workspace_id=excluded.workspace_id,company_id=excluded.company_id,user_id=excluded.user_id,document_id=excluded.document_id,chunk_index=excluded.chunk_index,content=excluded.content`);this.db.transaction((rows:KnowledgeEnginePoint[])=>{for(const point of rows)statement.run({...scope,...point})})(points)}
 async search(scope:KnowledgeEngineScope,query:{text:string;limit:number}){const expression=ftsQuery(query.text);if(!expression)return[];const rows=this.db.prepare(`SELECT d.point_id AS id,d.content,bm25(knowledge_fts) AS rank FROM knowledge_fts JOIN knowledge_fts_documents d ON d.rowid=knowledge_fts.rowid WHERE knowledge_fts MATCH @expression AND d.workspace_id=@workspaceId AND d.company_id=@companyId AND d.user_id=@userId ORDER BY rank,d.point_id LIMIT @limit`).all({...scope,expression,limit:Math.min(100,Math.max(1,query.limit))})as Array<{id:string;content:string;rank:number}>;return rows.map(row=>({id:row.id,content:row.content,score:1/(1+Math.abs(row.rank)),engine:this.name}))}
 async deleteDocument(scope:KnowledgeEngineScope&{documentId:string}){this.db.prepare("DELETE FROM knowledge_fts_documents WHERE workspace_id=@workspaceId AND company_id=@companyId AND user_id=@userId AND document_id=@documentId").run(scope)}
}
export class QdrantMemoryEngineAdapter implements KnowledgeMemoryEngine{
 readonly name="qdrant-int8";
 constructor(private readonly client:ProductionQdrantClient){}
 async health(){try{await this.client.health();return{healthy:true}}catch(error){return{healthy:false,detail:error instanceof Error?error.message:String(error)}}}
 async upsert(scope:KnowledgeEngineScope,points:KnowledgeEnginePoint[]){const grouped=new Map<string,KnowledgeEnginePoint[]>();for(const point of points)grouped.set(point.documentId,[...(grouped.get(point.documentId)??[]),point]);for(const[documentId,items]of grouped)await this.client.upsert({...scope,documentId},items.map(item=>({id:item.id,vector:item.vector??[],content:item.content,index:item.index})))}
 async search(scope:KnowledgeEngineScope,query:{vector?:number[];limit:number}){if(!query.vector?.length)return[];return(await this.client.search(scope,query.vector,query.limit)).map(hit=>({...hit,engine:this.name}))}
 async deleteDocument(scope:KnowledgeEngineScope&{documentId:string}){await this.client.deleteDocument(scope)}
}
export class ProductionMemoryEngineRegistry{
 constructor(private readonly engines:KnowledgeMemoryEngine[]){}
 names(){return["postgresql-pgvector",...this.engines.map(engine=>engine.name)]}
 async health(){return Promise.all(this.engines.map(async engine=>({engine:engine.name,...await engine.health()})))}
 async upsert(scope:KnowledgeEngineScope,points:KnowledgeEnginePoint[]){for(const engine of this.engines)await engine.upsert(scope,points)}
 async search(scope:KnowledgeEngineScope,text:string,vector:number[]|undefined,limit:number){const settled=await Promise.allSettled(this.engines.map(engine=>engine.search(scope,{text,vector,limit})));return settled.flatMap(result=>result.status==="fulfilled"?result.value:[])}
 async deleteDocument(scope:KnowledgeEngineScope&{documentId:string}){for(const engine of this.engines)await engine.deleteDocument(scope)}
}

import { createHash } from "node:crypto";
import { PassThrough,Readable } from "node:stream";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Client } from "minio";

export const NPATI_BUCKETS={chat:"npati-chat-files",knowledge:"npati-company-knowledge",generated:"npati-generated-media",exports:"npati-exports"} as const;
export type StoredObjectInfo={key:string;size:number;lastModified:Date;etag?:string};
export interface ObjectStorage {
  initialize():Promise<void>; health():Promise<"ok"|"unavailable">;
  put(bucket:string,key:string,data:Buffer,metadata?:Record<string,string>):Promise<void>;
  get(bucket:string,key:string):Promise<NodeJS.ReadableStream>; remove(bucket:string,key:string):Promise<void>;
  exists(bucket:string,key:string):Promise<boolean>; list(bucket:string,prefix?:string):AsyncIterable<StoredObjectInfo>;
}
export interface MinioStorageConfig {
  endPoint:string;port:number;useSSL:boolean;accessKey:string;secretKey:string;region?:string;
  operationTimeoutMs?:number;streamIdleTimeoutMs?:number;streamTotalTimeoutMs?:number;
}
const buckets=new Set<string>(Object.values(NPATI_BUCKETS));
function knownBucket(bucket:string){if(!buckets.has(bucket))throw new Error("Unknown NPATI bucket");}
export function objectKeySegment(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value) && value !== "." && value !== ".."
    ? value
    : "id-" + createHash("sha256").update(value).digest("hex").slice(0,32);
}

export function objectKey(parts:string[]){if(!parts.length||parts.some(part=>part==="."||part===".."||!/^[A-Za-z0-9._-]+$/.test(part)))throw new Error("Object key contains an unsafe segment");return parts.join("/");}
export function withOperationTimeout<T>(promise:Promise<T>,timeoutMs:number,label:string):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+" timed out after "+timeoutMs+"ms")),timeoutMs);timer.unref?.();});
  return Promise.race([promise,timeout]).finally(()=>{if(timer)clearTimeout(timer);});
}
export function withStreamTimeout(source:NodeJS.ReadableStream,idleMs:number,totalMs:number){
  const output=new PassThrough({objectMode:Boolean((source as {readableObjectMode?:boolean}).readableObjectMode)});let idle:NodeJS.Timeout,total:NodeJS.Timeout;
  const clear=()=>{clearTimeout(idle);clearTimeout(total);};
  const fail=(kind:string)=>{const error=new Error("MinIO download "+kind+" timeout");(source as NodeJS.ReadableStream & { destroy(error?:Error):void }).destroy(error);output.destroy(error);clear();};
  const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>fail("idle"),idleMs);idle.unref?.();};
  total=setTimeout(()=>fail("total"),totalMs);total.unref?.();reset();
  source.on("data",reset);source.once("end",clear);source.once("close",clear);source.once("error",clear);source.pipe(output);
  return output;
}
export class MinioObjectStorage implements ObjectStorage {
  private readonly client:Client;private readonly operationTimeoutMs:number;private readonly streamIdleTimeoutMs:number;private readonly streamTotalTimeoutMs:number;
  constructor(private readonly config:MinioStorageConfig){
    this.operationTimeoutMs=Math.max(1000,config.operationTimeoutMs??15_000);
    this.streamIdleTimeoutMs=Math.max(1000,config.streamIdleTimeoutMs??30_000);
    this.streamTotalTimeoutMs=Math.max(this.streamIdleTimeoutMs,config.streamTotalTimeoutMs??300_000);
    const {operationTimeoutMs:_operation,streamIdleTimeoutMs:_idle,streamTotalTimeoutMs:_total,...clientConfig}=config;
    const transportAgent=config.useSSL?new HttpsAgent({keepAlive:true,timeout:this.operationTimeoutMs}):new HttpAgent({keepAlive:true,timeout:this.operationTimeoutMs});
    this.client=new Client({...clientConfig,transportAgent});
  }
  private deadline<T>(promise:Promise<T>,label:string){return withOperationTimeout(promise,this.operationTimeoutMs,label);}
  async initialize(){for(const bucket of buckets)if(!await this.deadline(this.client.bucketExists(bucket),"MinIO bucket check"))await this.deadline(this.client.makeBucket(bucket,this.config.region??"us-east-1"),"MinIO bucket create");}
  async health(){try{await this.deadline(this.client.listBuckets(),"MinIO health");return "ok" as const;}catch{return "unavailable" as const;}}
  async put(bucket:string,key:string,data:Buffer,metadata:Record<string,string>={}){knownBucket(bucket);objectKey(key.split("/"));await this.deadline(this.client.putObject(bucket,key,data,data.length,metadata),"MinIO upload");}
  async get(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));const stream=await this.deadline(this.client.getObject(bucket,key),"MinIO download open");return withStreamTimeout(stream,this.streamIdleTimeoutMs,this.streamTotalTimeoutMs);}
  async remove(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));await this.deadline(this.client.removeObject(bucket,key),"MinIO delete");}
  async exists(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));try{await this.deadline(this.client.statObject(bucket,key),"MinIO stat");return true;}catch(error){const code=String((error as {code?:unknown}).code??"");if(code==="NotFound"||code==="NoSuchKey"||code==="NoSuchObject")return false;throw error;}}
  async *list(bucket:string,prefix=""){knownBucket(bucket);if(prefix)objectKey(prefix.replace(/\/$/,"").split("/"));const stream=withStreamTimeout(this.client.listObjectsV2(bucket,prefix,true),this.streamIdleTimeoutMs,this.streamTotalTimeoutMs);for await(const raw of stream as AsyncIterable<Record<string,unknown>>){const key=String(raw.name??"");if(!key)continue;yield {key,size:Number(raw.size??0),lastModified:raw.lastModified instanceof Date?raw.lastModified:new Date(String(raw.lastModified??0)),etag:raw.etag?String(raw.etag):undefined};}}
}
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects=new Map<string,{data:Buffer;lastModified:Date}>();
  async initialize(){}async health(){return "ok" as const;}
  async put(bucket:string,key:string,data:Buffer){knownBucket(bucket);objectKey(key.split("/"));this.objects.set(bucket+"/"+key,{data:Buffer.from(data),lastModified:new Date()});}
  async get(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));const value=this.objects.get(bucket+"/"+key);if(!value)throw Object.assign(new Error("Object not found"),{code:"NotFound"});return Readable.from(value.data);}
  async remove(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));this.objects.delete(bucket+"/"+key);}
  async exists(bucket:string,key:string){knownBucket(bucket);objectKey(key.split("/"));return this.objects.has(bucket+"/"+key);}
  async *list(bucket:string,prefix=""){knownBucket(bucket);for(const [full,value] of this.objects){const start=bucket+"/";if(full.startsWith(start+prefix)){const key=full.slice(start.length);yield {key,size:value.data.length,lastModified:value.lastModified};}}}
}

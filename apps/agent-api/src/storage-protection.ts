import { usageQuotasEnabled } from "./usage-quota-policy";
import type { AuthContext } from "@npati/workspace";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";

export type StorageRateAction = "upload" | "download" | "delete";
export type StorageRateLimits = Record<StorageRateAction,{ limit:number; windowMs:number }>;
export class StorageRateLimitError extends Error {
  readonly code="STORAGE_RATE_LIMITED";
  constructor(readonly retryAfterMs:number){super("Attachment rate limit exceeded");}
}
export interface StorageProtection {
  consume(context:AuthContext,action:StorageRateAction,cost?:number):Promise<void>;
  withLease<T>(name:string,ttlMs:number,task:()=>Promise<T>):Promise<{acquired:boolean;result?:T}>;
  close():Promise<void>;
}
export const defaultStorageRateLimits:StorageRateLimits={
  upload:{limit:30,windowMs:60_000},download:{limit:120,windowMs:60_000},delete:{limit:60,windowMs:60_000},
};
const rateScript=`local value=redis.call('INCRBY',KEYS[1],ARGV[1])
if value==tonumber(ARGV[1]) then redis.call('PEXPIRE',KEYS[1],ARGV[2]) end
local ttl=redis.call('PTTL',KEYS[1])
return {value,ttl}`;
const unlockScript=`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
export class RedisStorageProtection implements StorageProtection {
  private client?:ReturnType<typeof createClient>; private connecting?:Promise<ReturnType<typeof createClient>>;
  constructor(private readonly redisUrl:string,private readonly limits:StorageRateLimits=defaultStorageRateLimits){}
  private async get(){
    if(this.client?.isReady)return this.client;
    if(!this.connecting)this.connecting=(async()=>{const client=createClient({url:this.redisUrl});client.on("error",()=>undefined);await client.connect();this.client=client;return client;})().finally(()=>{this.connecting=undefined;});
    return this.connecting;
  }
  async consume(context:AuthContext,action:StorageRateAction,cost=1){
    if (!usageQuotasEnabled()) return;
    const rule=this.limits[action],tenant=createHash("sha256").update(context.workspaceId+"\0"+context.userId).digest("hex").slice(0,32);
    const result=await (await this.get()).eval(rateScript,{keys:[`npati:storage:rate:v1:${tenant}:${action}`],arguments:[String(Math.max(1,cost)),String(rule.windowMs)]}) as [number,number];
    if(Number(result[0])>rule.limit)throw new StorageRateLimitError(Math.max(1,Number(result[1])));
  }
  async withLease<T>(name:string,ttlMs:number,task:()=>Promise<T>){
    const client=await this.get(),key="npati:storage:lease:v1:"+name,token=randomUUID(),acquired=await client.set(key,token,{NX:true,PX:ttlMs});
    if(acquired!=="OK")return {acquired:false};
    try{return {acquired:true,result:await task()};}finally{await client.eval(unlockScript,{keys:[key],arguments:[token]}).catch(()=>undefined);}
  }
  async close(){if(this.client?.isOpen)await this.client.quit();}
}
export class InMemoryStorageProtection implements StorageProtection {
  private counts=new Map<string,{value:number;expires:number}>();private leases=new Set<string>();
  constructor(private readonly limits:StorageRateLimits=defaultStorageRateLimits){}
  async consume(context:AuthContext,action:StorageRateAction,cost=1){if (!usageQuotasEnabled()) return;const key=context.workspaceId+":"+context.userId+":"+action,now=Date.now(),rule=this.limits[action],old=this.counts.get(key),value=!old||old.expires<=now?{value:cost,expires:now+rule.windowMs}:{value:old.value+cost,expires:old.expires};this.counts.set(key,value);if(value.value>rule.limit)throw new StorageRateLimitError(value.expires-now);}
  async withLease<T>(name:string,_ttlMs:number,task:()=>Promise<T>){if(this.leases.has(name))return {acquired:false};this.leases.add(name);try{return {acquired:true,result:await task()};}finally{this.leases.delete(name);}}
  async close(){}
}

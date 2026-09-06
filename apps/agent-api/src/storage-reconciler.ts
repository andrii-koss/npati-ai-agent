import type { FileMetadataRepository,StoredFile } from "./file-metadata";
import { NPATI_BUCKETS,type ObjectStorage,type StoredObjectInfo } from "./object-storage";
import type { StorageProtection } from "./storage-protection";

export type StorageReconciliationSummary={scannedObjects:number;scannedRecords:number;removedOrphans:number;missingObjects:number;cleanedDeleted:number;skippedYoung:number};
export type StorageReconcilerOptions={intervalMs?:number;orphanGraceMs?:number;leaseMs?:number;pageSize?:number;onResult?:(summary:StorageReconciliationSummary)=>void;onError?:(error:unknown)=>void};
export class StorageReconciler {
  private timer?:NodeJS.Timeout;private running=false;
  private readonly intervalMs:number;private readonly orphanGraceMs:number;private readonly leaseMs:number;private readonly pageSize:number;
  constructor(private readonly storage:ObjectStorage,private readonly repository:FileMetadataRepository,private readonly protection:StorageProtection,private readonly options:StorageReconcilerOptions={}){
    this.intervalMs=Math.max(60_000,options.intervalMs??21_600_000);this.orphanGraceMs=Math.max(0,options.orphanGraceMs??86_400_000);this.leaseMs=Math.max(60_000,options.leaseMs??1_800_000);this.pageSize=Math.max(10,Math.min(1000,options.pageSize??250));
  }
  start(){if(this.timer)return;void this.run().catch(error=>this.options.onError?.(error));this.timer=setInterval(()=>void this.run().catch(error=>this.options.onError?.(error)),this.intervalMs);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  async run(){
    if(this.running)return {acquired:false};
    this.running=true;
    try{return await this.protection.withLease("orphan-reconciliation",this.leaseMs,async()=>{const summary=await this.reconcile();this.options.onResult?.(summary);return summary;});}
    finally{this.running=false;}
  }
  private async reconcile(){
    const summary:StorageReconciliationSummary={scannedObjects:0,scannedRecords:0,removedOrphans:0,missingObjects:0,cleanedDeleted:0,skippedYoung:0};
    for(const bucket of Object.values(NPATI_BUCKETS)){let batch:StoredObjectInfo[]=[];for await(const object of this.storage.list(bucket)){summary.scannedObjects++;batch.push(object);if(batch.length>=this.pageSize){await this.checkMinioBatch(bucket,batch,summary);batch=[];}}if(batch.length)await this.checkMinioBatch(bucket,batch,summary);}
    let afterId:string|undefined;
    for(;;){const files=await this.repository.listReconciliationPage(afterId,this.pageSize);if(!files.length)break;for(const file of files){summary.scannedRecords++;await this.checkDatabaseRecord(file,summary);}afterId=files.at(-1)!.id;if(files.length<this.pageSize)break;}
    await this.repository.auditReconciliation(undefined,"*","*","scan","succeeded",summary);
    return summary;
  }
  private async checkMinioBatch(bucket:string,objects:StoredObjectInfo[],summary:StorageReconciliationSummary){
    const existing=await this.repository.findExistingObjectKeys(bucket,objects.map(object=>object.key));
    for(const object of objects){if(existing.has(object.key))continue;if(Date.now()-object.lastModified.getTime()<this.orphanGraceMs){summary.skippedYoung++;continue;}
      const recheck=await this.repository.findExistingObjectKeys(bucket,[object.key]);if(recheck.has(object.key))continue;
      try{await this.storage.remove(bucket,object.key);summary.removedOrphans++;await this.repository.auditReconciliation(undefined,bucket,object.key,"minio_orphan_removed","succeeded",{size:object.size,lastModified:object.lastModified.toISOString()});}
      catch(error){await this.repository.auditReconciliation(undefined,bucket,object.key,"minio_orphan_removed","failed",{message:error instanceof Error?error.message:String(error)});throw error;}
    }
  }
  private async checkDatabaseRecord(file:StoredFile,summary:StorageReconciliationSummary){
    let exists:boolean;try{exists=await this.storage.exists(file.bucket,file.objectKey);}catch(error){await this.repository.auditReconciliation(file,file.bucket,file.objectKey,"database_object_missing","failed",{message:error instanceof Error?error.message:String(error)});throw error;}
    if(file.deletedAt){if(exists)await this.storage.remove(file.bucket,file.objectKey);await this.repository.markStorageDeleted(file.id);summary.cleanedDeleted++;return;}
    if(file.status==="ready"&&!exists){await this.repository.markMissingObject(file.id);summary.missingObjects++;await this.repository.auditReconciliation(file,file.bucket,file.objectKey,"database_object_missing","succeeded");}
  }
}

import type { AuthContext } from "@npati/workspace";
import type { FileMetadataRepository,StoredFile } from "./file-metadata";
import type { ObjectStorage } from "./object-storage";

export interface CleanupStoredFileOptions {
  action: "delete" | "cleanup";
  context?: AuthContext;
  detail?: Record<string,unknown>;
  throwOnFailure?: boolean;
}

/**
 * Deletes the binary first and only then confirms physical deletion in metadata.
 * A failed MinIO operation deliberately leaves storage_deleted_at unset so the
 * background reconciler (or a repeated DELETE) can retry safely.
 */
export async function cleanupStoredFileObject(
  storage:ObjectStorage,
  repository:FileMetadataRepository,
  file:StoredFile,
  options:CleanupStoredFileOptions,
):Promise<boolean>{
  if(file.storageDeletedAt)return true;
  try{
    await storage.remove(file.bucket,file.objectKey);
    if(await storage.exists(file.bucket,file.objectKey)){
      throw new Error("Object storage acknowledged delete but the object still exists");
    }
    await repository.markStorageDeleted(file.id);
  }catch(error){
    if(options.context){
      await repository.audit(options.context,file.id,options.action,"failed",{
        ...options.detail,
        message:error instanceof Error?error.message:String(error),
      }).catch(()=>undefined);
    }
    if(options.throwOnFailure)throw error;
    return false;
  }
  if(options.context){
    await repository.audit(options.context,file.id,options.action,"succeeded",options.detail).catch(()=>undefined);
  }
  return true;
}

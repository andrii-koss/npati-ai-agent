import { InMemoryWorkspaceStore, WorkspaceAccessError, type AuthContext } from "@npati/workspace";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFileService } from "../apps/agent-api/src/chat-file-service";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";
import { InMemoryObjectStorage } from "../apps/agent-api/src/object-storage";

const context: AuthContext={workspaceId:"ws-files",userId:"user-files",permissions:["workspace:read","business:manage"]};
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))});

async function setup(directory?:string){
  const workspace=new InMemoryWorkspaceStore();
  await workspace.initialize(context);
  const business=await workspace.createBusiness(context,{name:"Files business"});
  const conversation=await workspace.createConversation(context,business.id,"Files");
  const storage=new InMemoryObjectStorage();
  const repository=new InMemoryFileMetadataRepository();
  const service=new ChatFileService(storage,repository,workspace,directory);
  await storage.initialize();
  return {workspace,business,conversation,storage,repository,service};
}
async function body(stream:NodeJS.ReadableStream){let value="";for await(const chunk of stream)value+=Buffer.from(chunk).toString();return value;}

describe("ChatFileService",()=>{
  it("finds the latest spreadsheet directly from chat storage", async () => {
    const { business, conversation, service } = await setup();
    await service.persist(context, business.id, conversation.id, [
      { kind: "document", name: "notes.pdf", mimeType: "application/pdf", data: Buffer.from("pdf") },
      { kind: "document", name: "source.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from("xlsx") },
    ]);
    const latest = await service.latestChatSpreadsheet(context, conversation.id);
    expect(latest?.originalFilename).toBe("source.xlsx");
  });

  it("persists a private document idempotently and blocks another tenant",async()=>{
    const {business,conversation,repository,service}=await setup();
    const clientId=randomUUID(),data=Buffer.from("%PDF-1.7\nNPATI");
    const runs=await Promise.all(Array.from({length:12},()=>service.persist(context,business.id,conversation.id,[{
      clientId,kind:"document",name:"plan.pdf",mimeType:"application/pdf",data,
    }])));
    expect(new Set(runs.map(items=>items[0]!.id)).size).toBe(1);
    expect(await repository.listChat(context,conversation.id)).toHaveLength(1);
    const opened=await service.open(context,clientId);
    expect(opened&&await body(opened.stream)).toBe(data.toString());
    await expect(service.open({...context,workspaceId:"ws-other",userId:"user-other"},clientId)).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("handles concurrent and repeated delete without orphan objects",async()=>{
    const {business,conversation,repository,service}=await setup();
    const id=randomUUID();
    await service.persist(context,business.id,conversation.id,[{clientId:id,kind:"document",name:"notes.txt",mimeType:"text/plain",data:Buffer.from("safe notes")}]);
    await Promise.all(Array.from({length:10},()=>service.delete(context,id)));
    expect(await service.open(context,id)).toBeNull();
    expect(await repository.listPendingCleanup(10)).toHaveLength(0);
    await expect(service.delete(context,id)).resolves.toBe(false);
  });

  it("migrates legacy bin/json under the same UUID then removes local copies",async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),"npati-legacy-files-"));dirs.push(directory);
    const {business,service}=await setup(directory);
    const id=randomUUID(),data=Buffer.from("legacy attachment");
    await writeFile(path.join(directory,id+".bin"),data);
    await writeFile(path.join(directory,id+".json"),JSON.stringify({
      id,workspaceId:context.workspaceId,userId:context.userId,businessId:business.id,
      kind:"file",name:"legacy.txt",mimeType:"text/plain",size:data.length,
    }));
    await expect(service.migrateLegacy()).resolves.toEqual({migrated:1,failed:0});
    const opened=await service.open(context,id);
    expect(opened&&await body(opened.stream)).toBe("legacy attachment");
    await expect(readFile(path.join(directory,id+".bin"))).rejects.toThrow();
    await expect(service.migrateLegacy()).resolves.toEqual({migrated:0,failed:0});
  });
});

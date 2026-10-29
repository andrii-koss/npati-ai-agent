import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { screenshotHasDetail } from "../apps/agent-api/src/project-screenshot-content";
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type), body = Buffer.concat([name,data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = (crc>>>1)^((crc&1)?0xedb88320:0); }
  const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
export function screenshotFixture(detail: boolean, filter=0) {
  const width=4,height=3,channels=3,stride=width*channels;
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const raw=Buffer.alloc((stride+1)*height);let previous=Buffer.alloc(stride);
  for(let y=0;y<height;y++) {
    const row=Buffer.alloc(stride,255);if(detail&&y===height-1)row[stride-1]=30;
    raw[y*(stride+1)]=filter;
    for(let x=0;x<stride;x++) {
      const left=x>=channels?row[x-channels]!:0,up=previous[x]!,upperLeft=x>=channels?previous[x-channels]!:0;
      const p=left+up-upperLeft,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-upperLeft);
      const predictor=filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?a<=b&&a<=c?left:b<=c?up:upperLeft:0;
      raw[y*(stride+1)+1+x]=(row[x]!-predictor)&255;
    } previous=row;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
describe("project screenshot content",()=>{
  it.each([0,1,2,3,4])("rejects a uniformly blank PNG using filter %i",filter=>{expect(screenshotHasDetail(screenshotFixture(false,filter))).toBe(false);});
  it.each([0,1,2,3,4])("retains image detail using filter %i",filter=>{expect(screenshotHasDetail(screenshotFixture(true,filter))).toBe(true);});
  it("leaves unsupported or invalid encodings to the existing validation",()=>{expect(screenshotHasDetail(Buffer.from('invalid'))).toBe(true);});
});

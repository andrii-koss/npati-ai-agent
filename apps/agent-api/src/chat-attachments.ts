/* Chat attachments: input types, decoding and prompt assembly.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { extractDocumentText, inferMimeType } from "./document-extractor";
import { AIEngine } from "@npati/omniroute-adapter";
import { ResearchProgressEvent } from "@npati/web-research";

export type ChatAttachmentInput = {
  kind: "image" | "audio" | "document" | "file";
  clientId?: string;
  name: string;
  mimeType: string;
  dataBase64: string;
};

export const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const allowedAudioTypes = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac"]);
export const allowedDocumentTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/tsv",
  "application/csv",
  "application/json",
  "text/markdown",
  "text/x-markdown",
  "application/xml",
  "text/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/typescript",
  "text/yaml",
  "application/x-yaml",
  "text/x-yaml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-msexcel",
  "application/x-excel",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/tar",
  "application/x-compressed",
  "application/octet-stream",
]);
export const audioTypeAliases = new Map([
  ["audio/x-m4a", "audio/mp4"],
  ["audio/m4a", "audio/mp4"],
  ["audio/x-mp4", "audio/mp4"],
  ["audio/mp3", "audio/mpeg"],
]);

export function safeAttachmentName(value: string) {
  return value.replace(/[^\p{L}\p{N}._ -]/gu, "_").trim().slice(0, 120) || "attachment";
}

export function decodeAttachment(input: ChatAttachmentInput) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error("Attachment data is not valid base64.");
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw new Error("The attached file is empty.");
  let declaredMimeType = input.mimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (!declaredMimeType || declaredMimeType === "application/octet-stream") {
    declaredMimeType = inferMimeType(input.name, declaredMimeType || "application/octet-stream");
  }
  const mimeType = input.kind === "audio" ? audioTypeAliases.get(declaredMimeType) ?? declaredMimeType : declaredMimeType;
  const allowed = input.kind === "image" ? allowedImageTypes : input.kind === "audio" ? allowedAudioTypes : allowedDocumentTypes;
  if (!allowed.has(mimeType)) {
    const inferred = inferMimeType(input.name);
    if (!allowed.has(inferred)) {
      throw new Error("Unsupported " + input.kind + " format: " + input.mimeType);
    }
  }
  const limit = input.kind === "image" ? 5 * 1024 * 1024 : input.kind === "audio" ? 15 * 1024 * 1024 : 20 * 1024 * 1024;
  if (data.length > limit) throw new Error("The attached file is too large.");
  if (input.kind === "image") {
    const validSignature =
      (mimeType === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
      || (mimeType === "image/png" && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (mimeType === "image/gif" && data.subarray(0, 3).toString("ascii") === "GIF")
      || (mimeType === "image/webp" && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP");
    if (!validSignature) throw new Error("The image content does not match its declared format.");
  }
  if (input.kind === "document" || input.kind === "file") {
    const zip = data[0] === 0x50 && data[1] === 0x4b;
    const ole = data.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
    const isPdf = data.subarray(0,5).toString("ascii") === "%PDF-";
    const isGzip = data[0] === 0x1f && data[1] === 0x8b;
    const isTar = data.length >= 512 && data.subarray(257, 262).toString("ascii") === "ustar";
    const isText = !data.subarray(0, Math.min(4096, data.length)).includes(0);
    const validDocument = isPdf || zip || ole || isGzip || isTar || isText;
    if (!validDocument) throw new Error("The document content does not match its declared format.");
  }
  return { ...input, mimeType, name: safeAttachmentName(input.name), data };
}


export async function prepareChatAttachments(
  aiEngine: AIEngine,
  message: string,
  attachments: ChatAttachmentInput[] = [],
  progress?: (event: ResearchProgressEvent) => void,
) {
  if (attachments.length > 3) throw new Error("You can attach up to 3 files per message.");
  const decoded = attachments.map(decodeAttachment);
  if (decoded.reduce((total, item) => total + item.data.length, 0) > 20 * 1024 * 1024) {
    throw new Error("Attachments in one message must be 20 MB or smaller in total.");
  }
  const images = decoded.filter((item) => item.kind === "image").map((item) => ({ mimeType: item.mimeType, dataBase64: item.data.toString("base64") }));
  const audio = decoded.filter((item) => item.kind === "audio");
  const documents = decoded.filter((item) => item.kind === "document" || item.kind === "file");
  const transcripts: Array<{ name: string; text: string }> = [];
  const cleanMessage = message.trim();
  for (const image of decoded.filter((item) => item.kind === "image")) {
    progress?.({
      type: "page_fetch_started",
      url: `file://${encodeURIComponent(image.name)}`,
      domain: "file",
      title: image.name,
    });
  }
  for (const item of audio) {
    if (item.name.startsWith("speech-") && cleanMessage) {
      transcripts.push({ name: item.name, text: cleanMessage });
      continue;
    }
    if (!aiEngine.transcribeAudio) throw new Error("The selected AI runtime does not support audio transcription.");
    const result = await aiEngine.transcribeAudio({ data: item.data, mimeType: item.mimeType, filename: item.name });
    transcripts.push({ name: item.name, text: result.text });
  }

  const extractedDocs: Array<{ name: string; text: string }> = [];
  for (const doc of documents) {
    progress?.({ type: "page_fetch_started", url: `file://${encodeURIComponent(doc.name)}`, domain: "file", title: doc.name });
    try {
      const text = await extractDocumentText(doc.data, doc.mimeType, doc.name);
      extractedDocs.push({ name: doc.name, text });
      progress?.({ type: "page_fetch_completed", url: `file://${encodeURIComponent(doc.name)}`, domain: "file", title: doc.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      extractedDocs.push({ name: doc.name, text: `[Error reading attached file ${doc.name}: ${msg}]` });
      progress?.({ type: "page_fetch_failed", url: `file://${encodeURIComponent(doc.name)}`, domain: "file", title: doc.name, error: msg });
    }
  }

  const relevantTranscripts = transcripts.filter((item) => !(item.name.startsWith("speech-") && cleanMessage));
  const transcriptContext = relevantTranscripts.map((item) => "Voice message transcript (" + item.name + "):\n" + item.text).join("\n\n");
  const docContext = extractedDocs.map((item) => "Attached file content (" + item.name + "):\n```\n" + item.text + "\n```").join("\n\n");

  const basePrompt = cleanMessage
    || (images.length ? "Analyze the attached image and explain what is useful for my business."
      : extractedDocs.length ? "Analyze the attached file, table, or archive and answer my questions based on its content."
      : "Respond to my voice message.");

  const prompt = [basePrompt, transcriptContext, docContext].filter(Boolean).join("\n\n");
  const display = [
    cleanMessage,
    ...decoded.filter((item) => item.kind === "image").map((item) => "📷 Image: " + item.name),
    ...extractedDocs.map((item) => "📄 File: " + item.name),
    ...transcripts.map((item) => "🎤 Voice message: " + item.name + (item.name.startsWith("speech-") && cleanMessage ? "" : "\nTranscript: " + item.text)),
  ].filter(Boolean).join("\n\n");
  return { prompt, display, images, decoded, transcripts, extractedDocs };
}


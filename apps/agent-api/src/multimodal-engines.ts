import type { FastifyReply, FastifyRequest } from "fastify";
import type { AIEngine } from "@npati/omniroute-adapter";
import { WorkspaceAccessError, type WorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { ObjectStorage } from "./object-storage";
import { AudioTranslationEngine, VideoUnderstandingEngine } from "./swarm-audio-translation-video";
import { VideoGenerationPipeline } from "./radar-videogen-remote-cli";
import { MusicGenerationEngine, RealtimeSpeechEngine, VoiceCallManager } from "./voice-music-and-calls";
import { MobileVoiceAudioAdapter } from "./mobile-chat-voice-camera";

// Singletons for media generation and pipeline management
export const globalVideoPipeline = new VideoGenerationPipeline();
export const globalMusicEngine = new MusicGenerationEngine();
export const globalSpeechEngine = new RealtimeSpeechEngine();
export const globalVoiceCallManager = new VoiceCallManager();
export const globalMobileVoiceAdapter = new MobileVoiceAudioAdapter();
export const globalAudioTranslationEngine = new AudioTranslationEngine();
export const globalVideoUnderstandingEngine = new VideoUnderstandingEngine();

// Supported provider definitions for discovery
export const SUPPORTED_PROVIDERS = {
  imageGenerators: ["dall-e-3", "flux", "recraft", "sdxl"],
  imageEditors: ["inpaint", "outpaint", "style_transfer", "upscale", "background_remove"],
  videoEngines: ["runway-gen-3", "luma-dream-machine", "pika-2", "sora"],
  audioCodecs: ["opus", "pcm", "wav", "mp3"],
  documentFormats: ["markdown", "csv", "json", "text", "pdf", "docx"],
};

export interface MultimodalRouteDeps {
  auth: AuthProvider;
  store: WorkspaceStore;
  storage?: ObjectStorage;
  aiEngine: AIEngine;
}

export function hasPermission(scope: AuthContext, permission: string): boolean {
  if (scope.permissions.includes("*") || scope.permissions.includes("admin:all") || scope.permissions.includes("owner")) return true;
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return scope.permissions.includes("workspace:read") || scope.permissions.includes("workspace:write") || scope.permissions.includes("business:manage");
  }
  if (permission === "business:manage") {
    return scope.permissions.includes("business:manage") || scope.permissions.includes("workspace:write");
  }
  return false;
}

export async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!hasPermission(c, permission)) {
    throw new WorkspaceAccessError("Missing permission: " + permission);
  }
  return c;
}

export function err(reply: FastifyReply, e: unknown) {
  const errObj = e as { status?: number; code?: string; message?: string } | null;
  const status = Number(errObj?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: errObj?.code || (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "MULTIMODAL_ERROR"),
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

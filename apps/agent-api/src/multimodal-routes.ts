import type { FastifyInstance } from "fastify";
import {
  SUPPORTED_PROVIDERS,
  ctx,
  err,
  type MultimodalRouteDeps,
} from "./multimodal-engines";
import { registerMultimodalVisionAndDocRoutes } from "./multimodal-vision-and-doc-routes";
import { registerMultimodalMediaAndVoiceRoutes } from "./multimodal-media-and-voice-routes";

export * from "./multimodal-engines";
export * from "./multimodal-vision-and-doc-routes";
export * from "./multimodal-media-and-voice-routes";

export function registerMultimodalRoutes(
  app: FastifyInstance,
  deps: MultimodalRouteDeps,
) {
  const { auth } = deps;

  // 0. Provider Discovery
  app.get("/media/providers", async (r, reply) => {
    try {
      await ctx(auth, r, "workspace:read");
      return reply.code(200).send({
        providers: SUPPORTED_PROVIDERS,
        version: "1.2.0",
      });
    } catch (e) {
      return err(reply, e);
    }
  });

  registerMultimodalVisionAndDocRoutes(app, deps);
  registerMultimodalMediaAndVoiceRoutes(app, deps);
}

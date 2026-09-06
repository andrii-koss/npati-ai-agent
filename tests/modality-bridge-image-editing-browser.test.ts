import { describe, expect, it } from "vitest";
import {
  ModalityBridgeEngine,
  ImageEditingEngine,
  ManagedBrowserProfileService,
} from "../apps/agent-api/src/multimodal-bridge-and-browser";

describe("Modality Bridge (ModalityBridgeEngine)", () => {
  it("adapts image inputs into OCR text when target model lacks vision support", () => {
    const input = {
      text: "Summarize this uploaded invoice.",
      rawImageBuffer: Buffer.from("invoice_img_data"),
      imageDescriptionOrOcr: "Invoice #9882: Total $450.00, Due: Oct 15",
    };

    // Model WITHOUT vision (e.g. text-only model)
    const bridgedNoVision = ModalityBridgeEngine.bridgePayload(input, {
      supportsVision: false,
      supportsAudio: false,
    });

    expect(bridgedNoVision.attachedMedia.length).toBe(0);
    expect(bridgedNoVision.modalityConversionsApplied).toContain("transcoded_image_to_ocr_text");
    expect(bridgedNoVision.adaptedPrompt).toContain("<attached_image_ocr>");
    expect(bridgedNoVision.adaptedPrompt).toContain("Invoice #9882: Total $450.00");

    // Model WITH vision (e.g. GPT-4o / Claude 3.7)
    const bridgedWithVision = ModalityBridgeEngine.bridgePayload(input, {
      supportsVision: true,
      supportsAudio: false,
    });

    expect(bridgedWithVision.attachedMedia.length).toBe(1);
    expect(bridgedWithVision.attachedMedia[0].type).toBe("image");
    expect(bridgedWithVision.modalityConversionsApplied).toContain("pass_native_vision");
  });
});

describe("Image Generation & Editing (ImageEditingEngine)", () => {
  it("processes image inpainting and style transfer requests", async () => {
    const inpaintRes = await ImageEditingEngine.editImage({
      baseImageBase64: "base64_data",
      maskBase64: "mask_data",
      prompt: "Replace car with a bicycle",
      operation: "inpaint",
      targetDimensions: { width: 1024, height: 1024 },
    });

    expect(inpaintRes.editedImageUrl).toContain("edited_inpaint_");
    expect(inpaintRes.operationApplied).toBe("inpaint");
    expect(inpaintRes.dimensions.width).toBe(1024);
  });
});

describe("Managed Browser Profile Service (ManagedBrowserProfileService)", () => {
  it("creates, modifies cookies, and cleans up isolated browser profiles", () => {
    const service = new ManagedBrowserProfileService();
    const companyId = "comp-web-1";

    const profile = service.createProfile({
      companyId,
      profileName: "e-commerce-scraper",
      viewport: { width: 1920, height: 1080 },
    });

    expect(profile.profileId).toMatch(/^bprof_/);
    expect(profile.viewport.width).toBe(1920);

    // Save session cookies
    const cookieSaved = service.saveCookies(profile.profileId, [
      { name: "session_id", value: "abc123xyz", domain: "example.com" },
    ]);
    expect(cookieSaved).toBe(true);
    expect(service.getProfile(profile.profileId)?.cookies.length).toBe(1);

    // Destroy profile
    const destroyed = service.destroyProfile(profile.profileId);
    expect(destroyed).toBe(true);
    expect(service.getProfile(profile.profileId)).toBeNull();
  });
});

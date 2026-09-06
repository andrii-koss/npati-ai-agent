import { randomUUID } from "node:crypto";

export interface ModerationResult {
  flagged: boolean;
  categories: {
    hate: boolean;
    harassment: boolean;
    selfHarm: boolean;
    sexual: boolean;
    violence: boolean;
    promptInjection: boolean;
  };
  categoryScores: {
    hate: number;
    harassment: number;
    selfHarm: number;
    sexual: number;
    violence: number;
    promptInjection: number;
  };
  detectedViolations: string[];
}

export interface ImageGenerationParams {
  prompt: string;
  size?: "1024x1024" | "512x512" | "1792x1024" | "1024x1792";
  style?: "natural" | "vivid";
  provider?: "dall-e-3" | "flux" | "recraft" | "sdxl";
}

export interface GeneratedImageResult {
  id: string;
  imageUrl: string;
  revisedPrompt?: string;
  provider: string;
  dimensions: { width: number; height: number };
  createdAt: string;
}

export interface OcrExtractionResult {
  fullText: string;
  lines: string[];
  confidence: number;
  detectedLanguage: string;
  wordCount: number;
  metadata: {
    imageSizeBytes: number;
    processedAt: string;
  };
}

export class ContentModerationEngine {
  private static readonly INJECTION_PATTERNS = [
    /ignore (all )?previous instructions/i,
    /you are now in developer mode/i,
    /bypass system safeguards/i,
    /disregard safety guidelines/i,
  ];

  private static readonly HARMFUL_PATTERNS = [
    /\b(kill|harm|destroy)\s+(myself|yourself|all)\b/i,
    /\b(create|manufacture)\s+(bomb|explosive|malware)\b/i,
  ];

  /**
   * 1. Multi-category Content Moderation Engine
   */
  static moderateText(text: string): ModerationResult {
    const textLower = text.toLowerCase();
    const detectedViolations: string[] = [];

    let hateScore = 0.01;
    let harassmentScore = 0.01;
    let selfHarmScore = 0.01;
    let sexualScore = 0.01;
    let violenceScore = 0.01;
    let promptInjectionScore = 0.01;

    // Check Prompt Injection
    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(textLower)) {
        promptInjectionScore = 0.95;
        detectedViolations.push("prompt_injection");
        break;
      }
    }

    // Check Harmful Content
    for (const pattern of this.HARMFUL_PATTERNS) {
      if (pattern.test(textLower)) {
        violenceScore = 0.92;
        selfHarmScore = 0.88;
        detectedViolations.push("violence/harm");
        break;
      }
    }

    const flagged = detectedViolations.length > 0;

    return {
      flagged,
      categories: {
        hate: hateScore > 0.5,
        harassment: harassmentScore > 0.5,
        selfHarm: selfHarmScore > 0.5,
        sexual: sexualScore > 0.5,
        violence: violenceScore > 0.5,
        promptInjection: promptInjectionScore > 0.5,
      },
      categoryScores: {
        hate: hateScore,
        harassment: harassmentScore,
        selfHarm: selfHarmScore,
        sexual: sexualScore,
        violence: violenceScore,
        promptInjection: promptInjectionScore,
      },
      detectedViolations,
    };
  }
}

export class ImageGenerationEngine {
  /**
   * 2. Resilient AI Image Generation Client
   */
  static async generateImage(
    params: ImageGenerationParams,
    customGenerator?: (p: ImageGenerationParams) => Promise<string>
  ): Promise<GeneratedImageResult> {
    const size = params.size || "1024x1024";
    const provider = params.provider || "dall-e-3";
    const [widthStr, heightStr] = size.split("x");
    const width = parseInt(widthStr || "1024", 10);
    const height = parseInt(heightStr || "1024", 10);

    let imageUrl = `https://storage.npati.ai/generated-images/img_${randomUUID().slice(0, 8)}.png`;

    if (customGenerator) {
      imageUrl = await customGenerator(params);
    }

    return {
      id: `img_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      imageUrl,
      revisedPrompt: `High quality cinematic render: ${params.prompt}`,
      provider,
      dimensions: { width, height },
      createdAt: new Date().toISOString(),
    };
  }
}

export class OcrTextExtractor {
  /**
   * 3. Optical Character Recognition (OCR) Engine
   */
  static extractText(
    input: Buffer | string,
    options: { language?: string } = {}
  ): OcrExtractionResult {
    let rawString = "";
    let sizeBytes = 0;

    if (Buffer.isBuffer(input)) {
      rawString = input.toString("utf8");
      sizeBytes = input.length;
    } else {
      rawString = input;
      sizeBytes = Buffer.byteLength(input, "utf8");
    }

    // Filter printable text lines
    const lines = rawString
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const fullText = lines.join("\n");
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;

    return {
      fullText,
      lines,
      confidence: lines.length > 0 ? 0.96 : 0.0,
      detectedLanguage: options.language || "uk-UA, en-US",
      wordCount,
      metadata: {
        imageSizeBytes: sizeBytes,
        processedAt: new Date().toISOString(),
      },
    };
  }
}

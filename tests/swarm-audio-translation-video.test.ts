import { describe, expect, it } from "vitest";
import {
  SwarmOrchestrator,
  AudioTranslationEngine,
  VideoUnderstandingEngine,
} from "../apps/agent-api/src/swarm-audio-translation-video";

describe("Swarm Orchestrator (Swarm)", () => {
  it("orchestrates client-side multi-agent routines with dynamic handoffs", () => {
    const swarm = new SwarmOrchestrator();

    swarm.registerAgent({
      name: "TriageAgent",
      instructions: "Greet users and route billing questions to BillingAgent.",
      handoffs: ["BillingAgent"],
    });

    swarm.registerAgent({
      name: "BillingAgent",
      instructions: "Resolve subscription and refund requests.",
      handoffs: ["TriageAgent"],
    });

    // Request with billing intent triggers handoff
    const result = swarm.executeTurn("TriageAgent", "I need help with my billing invoice");

    expect(result.handoffOccurred).toBe(true);
    expect(result.activeAgent).toBe("BillingAgent");
    expect(result.messages.length).toBe(3);
    expect(result.messages[1]!.content).toContain("[Handoff] Delegating task to BillingAgent");
  });
});

describe("Audio Translation Engine (Audio translation)", () => {
  it("transcribes and translates audio speech across languages", () => {
    const engine = new AudioTranslationEngine();
    const mockAudio = Buffer.from("RIFF_WAV_AUDIO_SAMPLE_UKRAINIAN_SPEECH");

    const result = engine.translate(mockAudio, {
      sourceLanguage: "uk",
      targetLanguage: "en",
    });

    expect(result.sourceLanguageDetected).toBe("uk");
    expect(result.targetLanguage).toBe("en");
    expect(result.confidenceScore).toBeGreaterThan(0.9);
    expect(result.translatedText).toContain("Translated audio speech");
  });
});

describe("Video Understanding Engine (Video understanding)", () => {
  it("samples frames and reasons about temporal visual scenes", () => {
    const engine = new VideoUnderstandingEngine();

    const analysis = engine.analyze(
      { url: "https://example.com/demo.mp4", durationSeconds: 20, fps: 2 },
      "What is shown on the dashboard?"
    );

    expect(analysis.framesAnalyzed).toBe(40);
    expect(analysis.scenes.length).toBe(3);
    expect(analysis.scenes[0]!.description).toContain("Opening screen");
    expect(analysis.answer).toContain("Visual confirmation verified");
  });
});

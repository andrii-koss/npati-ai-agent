import { describe, expect, it } from "vitest";
import {
  MusicGenerationEngine,
  RealtimeSpeechEngine,
  VoiceCallManager,
} from "../apps/agent-api/src/voice-music-and-calls";

describe("Music Generation Engine (Music generation)", () => {
  it("synthesizes music track with metadata and duration parameters", () => {
    const engine = new MusicGenerationEngine();

    const track = engine.generate({
      prompt: "Upbeat cyberpunk synthwave driving beat",
      genre: "synthwave",
      durationSeconds: 120,
      tempoBpm: 128,
    });

    expect(track.status).toBe("completed");
    expect(track.genre).toBe("synthwave");
    expect(track.durationSeconds).toBe(120);
    expect(track.tempoBpm).toBe(128);
    expect(track.audioUrl).toContain(".mp3");
  });
});

describe("Realtime Speech Engine (Talk / realtime speech)", () => {
  it("manages bidirectional speech session, detects speech frames, and handles interruptions", () => {
    const engine = new RealtimeSpeechEngine();

    const session = engine.startSession("session_voice_1", "ukrainian_female");
    expect(session.status).toBe("connected");

    // 1. User speaks -> VAD active
    const vadChunk = engine.processAudioChunk(
      "session_voice_1",
      true,
      "Привіт, покажи графік продуктивності."
    );
    expect(vadChunk.status).toBe("listening");
    expect(engine.getSession("session_voice_1")?.lastTranscription).toContain("Привіт");

    // 2. User stops speaking -> Agent responds
    const agentChunk = engine.processAudioChunk("session_voice_1", false);
    expect(agentChunk.status).toBe("speaking");
    expect(agentChunk.agentResponseAudioBytes).toBeGreaterThan(0);

    // 3. User interrupts while agent is speaking
    const interruptChunk = engine.processAudioChunk("session_voice_1", true, "Зачекай");
    expect(interruptChunk.status).toBe("listening");
    expect(engine.getSession("session_voice_1")?.interruptedCount).toBe(1);

    engine.endSession("session_voice_1");
    expect(engine.getSession("session_voice_1")?.status).toBe("disconnected");
  });
});

describe("Voice Call Manager (Voice Call)", () => {
  it("manages telephony call lifecycle and records call summary", () => {
    const manager = new VoiceCallManager();

    const call = manager.makeCall({
      toPhoneNumber: "+380501234567",
      callerId: "+380449998877",
      initialPrompt: "Доброго дня, це автоматичний асистент сервісу.",
    });

    expect(call.status).toBe("in-progress");
    expect(call.toPhoneNumber).toBe("+380501234567");

    const completed = manager.completeCall(
      call.callId,
      45,
      "Клієнт підтвердив перенесення візиту на середу."
    );

    expect(completed.status).toBe("completed");
    expect(completed.durationSeconds).toBe(45);
    expect(completed.transcriptSummary).toContain("перенесення візиту");
  });
});

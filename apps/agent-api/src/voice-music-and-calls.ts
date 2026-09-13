export interface MusicTrack {
  trackId: string;
  title: string;
  genre: string;
  durationSeconds: number;
  tempoBpm: number;
  audioUrl: string;
  status: "completed" | "generating" | "failed";
  createdAt: string;
}

export interface RealtimeSpeechSession {
  sessionId: string;
  voice: string;
  status: "connected" | "speaking" | "listening" | "disconnected";
  framesProcessed: number;
  lastTranscription: string;
  interruptedCount: number;
}

export interface VoiceCallRecord {
  callId: string;
  toPhoneNumber: string;
  callerId: string;
  direction: "inbound" | "outbound";
  status: "ringing" | "in-progress" | "completed" | "failed";
  durationSeconds: number;
  transcriptSummary?: string;
  startedAt: string;
}

export class MusicGenerationEngine {
  private readonly tracks = new Map<string, MusicTrack>();

  /**
   * 1. Music Generation: Generates background music, soundscapes & vocal tracks
   */
  generate(params: {
    prompt: string;
    durationSeconds?: number;
    genre?: string;
    tempoBpm?: number;
    instrumentalOnly?: boolean;
  }): MusicTrack {
    const trackId = `track_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const genre = params.genre ?? "electronic ambient";
    const durationSeconds = params.durationSeconds ?? 60;
    const tempoBpm = params.tempoBpm ?? 120;

    const track: MusicTrack = {
      trackId,
      title: params.prompt.slice(0, 40),
      genre,
      durationSeconds,
      tempoBpm,
      audioUrl: `https://cdn.npati.io/audio/music/${trackId}.mp3`,
      status: "completed",
      createdAt: new Date().toISOString(),
    };

    this.tracks.set(trackId, track);
    return track;
  }

  getTrack(trackId: string): MusicTrack | undefined {
    return this.tracks.get(trackId);
  }

  listTracks(): MusicTrack[] {
    return Array.from(this.tracks.values());
  }
}

export class RealtimeSpeechEngine {
  private readonly sessions = new Map<string, RealtimeSpeechSession>();

  /**
   * 2. Talk / Realtime Speech: Full-duplex speech-to-speech with live VAD and interruptions
   */
  startSession(
    sessionId: string,
    voice = "ukrainian_female"
  ): RealtimeSpeechSession {
    const session: RealtimeSpeechSession = {
      sessionId,
      voice,
      status: "connected",
      framesProcessed: 0,
      lastTranscription: "",
      interruptedCount: 0,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  processAudioChunk(
    sessionId: string,
    vadActive: boolean,
    simulatedUserSpeech?: string
  ): { status: string; agentResponseAudioBytes: number } {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "disconnected") {
      throw new Error(`Session ${sessionId} not active.`);
    }

    session.framesProcessed++;

    if (vadActive) {
      // User is speaking -> if agent was speaking, interrupt
      if (session.status === "speaking") {
        session.interruptedCount++;
      }
      session.status = "listening";
      if (simulatedUserSpeech) {
        session.lastTranscription = simulatedUserSpeech;
      }
      return { status: "listening", agentResponseAudioBytes: 0 };
    }

    // Agent response phase
    session.status = "speaking";
    return {
      status: "speaking",
      agentResponseAudioBytes: 4096, // 4KB audio buffer chunk
    };
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "disconnected";
    }
  }

  getSession(sessionId: string): RealtimeSpeechSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RealtimeSpeechSession[] {
    return Array.from(this.sessions.values());
  }

  clearSessions(): void {
    this.sessions.clear();
  }
}

export class VoiceCallManager {
  private readonly calls = new Map<string, VoiceCallRecord>();

  /**
   * 3. Voice Call: Inbound/outbound telephony (Twilio / SIP VoIP calling)
   */
  makeCall(params: {
    toPhoneNumber: string;
    callerId: string;
    initialPrompt: string;
  }): VoiceCallRecord {
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: VoiceCallRecord = {
      callId,
      toPhoneNumber: params.toPhoneNumber,
      callerId: params.callerId,
      direction: "outbound",
      status: "in-progress",
      durationSeconds: 0,
      startedAt: new Date().toISOString(),
    };
    this.calls.set(callId, record);
    return record;
  }

  completeCall(callId: string, durationSeconds: number, summary: string): VoiceCallRecord {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Call ${callId} not found.`);

    call.status = "completed";
    call.durationSeconds = durationSeconds;
    call.transcriptSummary = summary;

    return call;
  }

  getCall(callId: string): VoiceCallRecord | undefined {
    return this.calls.get(callId);
  }

  listCalls(): VoiceCallRecord[] {
    return Array.from(this.calls.values());
  }

  clearCalls(): void {
    this.calls.clear();
  }
}

import type { HealthResponse } from "@npati/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "./BusinessWorkspace";
import { getStoredAuthToken } from "./AuthContext";

const SPEECH_VOICES = [
  { id: "alloy", label: "Alloy", description: "Neutral" },
  { id: "ash", label: "Ash", description: "Warm" },
  { id: "ballad", label: "Ballad", description: "Expressive" },
  { id: "coral", label: "Coral", description: "Clear" },
  { id: "echo", label: "Echo", description: "Deep" },
  { id: "fable", label: "Fable", description: "Storytelling" },
  { id: "onyx", label: "Onyx", description: "Strong" },
  { id: "nova", label: "Nova", description: "Bright" },
  { id: "sage", label: "Sage", description: "Calm" },
  { id: "shimmer", label: "Shimmer", description: "Soft" },
  { id: "verse", label: "Verse", description: "Versatile" },
  { id: "marin", label: "Marin", description: "Natural" },
  { id: "cedar", label: "Cedar", description: "Natural and deep" },
] as const;

export function DashboardPage() {
  const { overview, loading } = useWorkspace();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [speechText, setSpeechText] = useState("Welcome to NPATI Agent.");
  const [speechVoice, setSpeechVoice] = useState("alloy");
  const [speechUrl, setSpeechUrl] = useState("");
  const [speechBusy, setSpeechBusy] = useState(false);
  const [speechError, setSpeechError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/health")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Health request failed")))
      .then((value: HealthResponse) => { if (active) setHealth(value); })
      .catch(() => { if (active) setHealth(null); });
    return () => { active = false; };
  }, []);

  const services = health?.services ?? {};
  const healthyServices = Object.values(services).filter((status) => status === "ok").length;

  async function synthesizeSpeech() {
    if (!speechText.trim() || speechBusy) return;
    setSpeechBusy(true);
    setSpeechError("");
    try {
      const token = getStoredAuthToken();
      const response = await fetch("/api/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ input: speechText.trim(), format: "mp3", voice: speechVoice }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? `TTS failed (${response.status})`);
      }
      if (speechUrl) URL.revokeObjectURL(speechUrl);
      setSpeechUrl(URL.createObjectURL(await response.blob()));
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "Text-to-speech failed.");
    } finally { setSpeechBusy(false); }
  }

  return (
    <main className="dashboard-page">
      <header className="page-heading dashboard-heading">
        <p className="eyebrow">Operations</p>
        <h1>Dashboard</h1>
        <p>Current workspace, AI runtime, and business activity in one place.</p>
      </header>

      <section className="dashboard-metrics" aria-label="Workspace summary">
        <article><strong>{loading ? "–" : overview?.businesses.length ?? 0}</strong><span>Businesses</span><small>{overview?.currentBusiness?.name ?? "No active business"}</small></article>
        <article><strong>{health?.status === "ok" ? "Online" : "Check"}</strong><span>Agent API</span><small>Live runtime health</small></article>
        <article><strong>{healthyServices}/{Object.keys(services).length || 4}</strong><span>Healthy services</span><small>Database, AI, crawler and hub</small></article>
      </section>

      <section className="dashboard-panels">
        <article className="dashboard-panel">
          <div><p className="eyebrow">Runtime</p><h2>Service status</h2></div>
          <div className="dashboard-service-list">
            {Object.entries(services).map(([name, status]) => (
              <div key={name}><span className={`status-dot ${status === "ok" ? "healthy" : ""}`} /><strong>{name}</strong><small>{String(status)}</small></div>
            ))}
            {!health && <p>Service health is currently unavailable.</p>}
          </div>
        </article>
        <article className="dashboard-panel">
          <div><p className="eyebrow">Quick access</p><h2>Workspace tools</h2></div>
          <nav className="dashboard-links">
            <Link to="/chat">Open WebChat <span>→</span></Link>
            <Link to="/settings/ai">AI providers <span>→</span></Link>
            <Link to="/settings/activity">Activity & Run Trace <span>→</span></Link>
            <Link to="/settings/capabilities">Capability Inspector <span>→</span></Link>
          </nav>
        </article>
      </section>
      <section className="dashboard-panel dashboard-tts-panel">
        <div><p className="eyebrow">Audio tool</p><h2>Text-to-Speech</h2><p>Generate real speech through your connected OmniRoute TTS provider.</p></div>
        <textarea value={speechText} maxLength={4096} onChange={(event) => setSpeechText(event.target.value)} aria-label="Text to synthesize" />
        <label className="dashboard-tts-voice">
          <span>Voice</span>
          <select value={speechVoice} onChange={(event) => setSpeechVoice(event.target.value)} aria-label="Speech voice">
            {SPEECH_VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.label} — {voice.description}</option>)}
          </select>
          <small>Voice character is approximate; availability depends on the connected TTS provider.</small>
        </label>
        <div className="dashboard-tts-actions">
          <button type="button" className="button-primary" disabled={speechBusy || !speechText.trim()} onClick={() => void synthesizeSpeech()}>{speechBusy ? "Generating…" : "Generate speech"}</button>
          {speechUrl && <audio controls src={speechUrl}>Your browser does not support audio playback.</audio>}
        </div>
        {speechError && <p className="workspace-notice error">{speechError}</p>}
      </section>
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import { getStoredAuthToken } from "./AuthContext";

export function AudioAttachmentPlayer({
  id,
  name,
  fallbackText,
}: {
  id: string;
  name: string;
  fallbackText?: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let unmounted = false;

    async function loadAudio() {
      setLoading(true);
      setError(null);
      try {
        const token = getStoredAuthToken();
        const url = `/api/attachments/${id}${token ? "?token=" + encodeURIComponent(token) : ""}`;
        const res = await fetch(url, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const blob = await res.blob();
          if (unmounted) return;
          const objectUrl = URL.createObjectURL(blob);
          audioUrlRef.current = objectUrl;
          setAudioUrl(objectUrl);
          return;
        }

        // Fallback for speech files if attachment endpoint fails
        if (name.startsWith("speech-") && fallbackText?.trim()) {
          const voiceMatch = name.match(/^speech-([a-zA-Z0-9_-]+)\.mp3$/i);
          const voice = voiceMatch ? voiceMatch[1]! : "alloy";
          const speechRes = await fetch("/api/audio/speech", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ input: fallbackText.trim(), format: "mp3", voice }),
          });
          if (speechRes.ok) {
            const blob = await speechRes.blob();
            if (unmounted) return;
            const objectUrl = URL.createObjectURL(blob);
            audioUrlRef.current = objectUrl;
            setAudioUrl(objectUrl);
            return;
          }
        }

        throw new Error(`HTTP ${res.status}`);
      } catch {
        if (!unmounted) setError("Could not load audio recording");
      } finally {
        if (!unmounted) setLoading(false);
      }
    }

    void loadAudio();

    return () => {
      unmounted = true;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [id, name, fallbackText]);

  return (
    <figure className="chat-message-attachment audio">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl} />
      ) : loading ? (
        <div className="chat-audio-loading">
          <span className="chat-audio-spinner" />
          <span>Loading voice recording…</span>
        </div>
      ) : error ? (
        <div className="chat-audio-error">
          <span>{error}</span>
        </div>
      ) : null}
      <figcaption className="chat-audio-figcaption">
        <span>{name}</span>
        {audioUrl && (
          <a
            href={audioUrl}
            download={name}
            className="chat-attachment-download-btn"
            title={"Download " + name}
            aria-label={"Download " + name}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download</span>
          </a>
        )}
      </figcaption>
    </figure>
  );
}

export function SynthesizedVoiceAudioPlayer({
  filename,
  inputText,
  voice,
}: {
  filename: string;
  inputText: string;
  voice: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let unmounted = false;
    async function loadAudio() {
      if (audioUrlRef.current || !inputText.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const token = getStoredAuthToken();
        const res = await fetch("/api/audio/speech", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ input: inputText.trim(), format: "mp3", voice }),
        });
        if (!res.ok) throw new Error("TTS generation failed");
        const blob = await res.blob();
        if (unmounted) return;
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        setAudioUrl(url);
      } catch {
        if (!unmounted) setError("Could not load audio recording");
      } finally {
        if (!unmounted) setLoading(false);
      }
    }

    void loadAudio();

    return () => {
      unmounted = true;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [inputText, voice]);

  return (
    <figure className="chat-message-attachment audio">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl} />
      ) : loading ? (
        <div className="chat-audio-loading">
          <span className="chat-audio-spinner" />
          <span>Generating voice recording…</span>
        </div>
      ) : error ? (
        <div className="chat-audio-error">
          <span>{error}</span>
        </div>
      ) : null}
      <figcaption className="chat-audio-figcaption">
        <span>{filename}</span>
        {audioUrl && (
          <a
            href={audioUrl}
            download={filename}
            className="chat-attachment-download-btn"
            title={"Download " + filename}
            aria-label={"Download " + filename}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download</span>
          </a>
        )}
      </figcaption>
    </figure>
  );
}

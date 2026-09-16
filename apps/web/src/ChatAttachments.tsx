import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { SPEECH_VOICES } from "./speech-voices";

export type ChatAttachmentInput = {
  kind: "image" | "audio" | "document" | "file";
  clientId?: string;
  name: string;
  mimeType: string;
  dataBase64: string;
};

export type FileCategory = "image" | "audio" | "excel" | "word" | "pdf" | "presentation" | "archive" | "code" | "document";

export function getFileCategory(name: string, mimeType?: string, kind?: string): FileCategory {
  if (kind === "image" || mimeType?.startsWith("image/")) return "image";
  if (kind === "audio" || mimeType?.startsWith("audio/")) return "audio";

  const lowerName = (name || "").toLowerCase();
  const lowerMime = (mimeType || "").toLowerCase();

  if (
    /\.(xlsx?|csv|tsv|ods|xlsm|xlsb)$/i.test(lowerName) ||
    lowerMime.includes("spreadsheet") ||
    lowerMime.includes("excel") ||
    lowerMime === "text/csv" ||
    lowerMime.includes("csv")
  ) {
    return "excel";
  }

  if (/\.pdf$/i.test(lowerName) || lowerMime.includes("pdf")) {
    return "pdf";
  }

  if (
    /\.(docx?|rtf|odt)$/i.test(lowerName) ||
    lowerMime.includes("wordprocessingml") ||
    lowerMime.includes("msword")
  ) {
    return "word";
  }

  if (
    /\.(pptx?|odp)$/i.test(lowerName) ||
    lowerMime.includes("presentationml") ||
    lowerMime.includes("powerpoint")
  ) {
    return "presentation";
  }

  if (
    /\.(zip|rar|7z|tar|gz|bz2)$/i.test(lowerName) ||
    lowerMime.includes("zip") ||
    lowerMime.includes("compressed") ||
    lowerMime.includes("archive")
  ) {
    return "archive";
  }

  if (
    /\.(json|js|ts|tsx|jsx|py|html|css|sql|xml|yaml|yml)$/i.test(lowerName) ||
    lowerMime.includes("json") ||
    lowerMime.includes("javascript") ||
    lowerMime.includes("xml")
  ) {
    return "code";
  }

  return "document";
}

export function AttachmentFileIcon({
  item,
  className = "",
}: {
  item: { name: string; mimeType?: string; kind?: string; dataBase64?: string };
  className?: string;
}) {
  const category = getFileCategory(item.name, item.mimeType, item.kind);

  if (category === "image" && item.dataBase64) {
    return (
      <img
        src={"data:" + (item.mimeType || "image/png") + ";base64," + item.dataBase64}
        alt={item.name}
        className={className}
        loading="eager"
        onLoad={() => window.dispatchEvent(new CustomEvent("npati:chat-image-loaded"))}
      />
    );
  }

  return (
    <span className={`chat-file-icon ${category} ${className}`} aria-label={`${category} file`}>
      {category === "excel" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <rect x="8" y="12" width="8" height="8" rx="1" strokeWidth="1.5" />
          <line x1="8" y1="16" x2="16" y2="16" strokeWidth="1.5" />
          <line x1="12" y1="12" x2="12" y2="20" strokeWidth="1.5" />
        </svg>
      ) : category === "pdf" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <text x="7" y="18" fill="currentColor" stroke="none" fontSize="7" fontWeight="bold" fontFamily="sans-serif">PDF</text>
        </svg>
      ) : category === "word" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="14" y2="17" />
        </svg>
      ) : category === "presentation" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <rect x="8" y="12" width="8" height="7" rx="1" strokeWidth="1.5" />
          <circle cx="12" cy="15.5" r="1.5" strokeWidth="1.5" />
        </svg>
      ) : category === "audio" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l10-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      ) : category === "code" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      ) : category === "archive" ? (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <line x1="10" y1="12" x2="14" y2="12" strokeWidth="2" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="12" y2="17" />
        </svg>
      )}
    </span>
  );
}

export function PendingMessageAttachments({ value }: { value: ChatAttachmentInput[] }) {
  if (value.length === 0) return null;
  return <div className="chat-sent-attachments">
    {value.map((item, index) => item.kind === "image"
      ? <figure className="chat-message-attachment image" key={index + item.name}>
          <img
            src={"data:" + item.mimeType + ";base64," + item.dataBase64}
            alt={item.name}
            loading="eager"
            onLoad={() => window.dispatchEvent(new CustomEvent("npati:chat-image-loaded"))}
          />
          <figcaption>{item.name}</figcaption>
        </figure>
      : item.kind === "audio"
        ? <figure className="chat-message-attachment audio" key={index + item.name}>
            <audio controls src={"data:" + item.mimeType + ";base64," + item.dataBase64} />
            <figcaption className="chat-audio-figcaption">
              <span>{item.name}</span>
              <a
                href={"data:" + item.mimeType + ";base64," + item.dataBase64}
                download={item.name}
                className="chat-attachment-download-btn"
                title={"Download " + item.name}
                aria-label={"Download " + item.name}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download</span>
              </a>
            </figcaption>
          </figure>
        : <figure className="chat-message-attachment document" key={index + item.name}>
            <AttachmentFileIcon item={item} />
            <div className="chat-document-info">
              <span className="chat-document-name" title={item.name}>{item.name}</span>
            </div>
          </figure>)}
  </div>;
}

const IMAGE_LIMIT = 5 * 1024 * 1024;
const AUDIO_LIMIT = 15 * 1024 * 1024;
const DOCUMENT_LIMIT = 20 * 1024 * 1024;
const audioTypeAliases: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "audio/mp3": "audio/mpeg",
};

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function ChatAttachments({
  value,
  onChange,
  onError,
  disabled,
  privateRequestEnabled,
  onPrivateRequestChange,
  ttsEnabled,
  onTtsEnabledChange,
  ttsVoice,
  onTtsVoiceChange,
  inputText,
  onGenerateSpeech,
  isGeneratingSpeech,
}: {
  value: ChatAttachmentInput[];
  onChange(value: ChatAttachmentInput[]): void;
  onError(message: string): void;
  disabled?: boolean;
  privateRequestEnabled?: boolean;
  onPrivateRequestChange?(enabled: boolean): void;
  ttsEnabled?: boolean;
  onTtsEnabledChange?(enabled: boolean): void;
  ttsVoice?: string;
  onTtsVoiceChange?(voice: string): void;
  inputText?: string;
  onGenerateSpeech?(): Promise<void>;
  isGeneratingSpeech?: boolean;
}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const attachmentRoot = useRef<HTMLElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localMode, setLocalMode] = useState<"none" | "private" | "tts">("none");
  const [localTtsVoice, setLocalTtsVoice] = useState(() => {
    try {
      return localStorage.getItem("npati_chat_tts_voice") || "alloy";
    } catch {
      return "alloy";
    }
  });

  const activePrivateRequest = privateRequestEnabled !== undefined ? Boolean(privateRequestEnabled) : localMode === "private";
  const activeTtsEnabled = ttsEnabled !== undefined ? Boolean(ttsEnabled) : localMode === "tts";
  const activeTtsVoice = ttsVoice !== undefined ? ttsVoice : localTtsVoice;

  const handleTogglePrivateRequest = (checked: boolean) => {
    if (onPrivateRequestChange) {
      onPrivateRequestChange(checked);
    } else {
      setLocalMode(checked ? "private" : "none");
    }
  };

  const handleToggleTts = (checked: boolean) => {
    if (onTtsEnabledChange) {
      onTtsEnabledChange(checked);
    } else {
      setLocalMode(checked ? "tts" : "none");
    }
  };

  const handleVoiceChange = (voice: string) => {
    setLocalTtsVoice(voice);
    try {
      localStorage.setItem("npati_chat_tts_voice", voice);
    } catch {}
    onTtsVoiceChange?.(voice);
  };

  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), []);

function inferClientMimeType(name: string, type?: string): string {
  if (type && type !== "application/octet-stream") return type.toLowerCase().split(";", 1)[0]!;
  const lower = name.toLowerCase();
  if (/\.(xlsx|xlsm|xlsb)$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.xls$/i.test(lower)) return "application/vnd.ms-excel";
  if (/\.csv$/i.test(lower)) return "text/csv";
  if (/\.tsv$/i.test(lower)) return "text/tab-separated-values";
  if (/\.pdf$/i.test(lower)) return "application/pdf";
  if (/\.(docx|doc)$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.(pptx|ppt)$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (/\.zip$/i.test(lower)) return "application/zip";
  if (/\.(tar|tar\.gz|tgz)$/i.test(lower)) return "application/x-tar";
  if (/\.gz$/i.test(lower)) return "application/gzip";
  if (/\.json$/i.test(lower)) return "application/json";
  if (/\.xml$/i.test(lower)) return "application/xml";
  if (/\.(txt|log|ini|cfg|env)$/i.test(lower)) return "text/plain";
  if (/\.(md|markdown)$/i.test(lower)) return "text/markdown";
  if (/\.(m4a)$/i.test(lower)) return "audio/mp4";
  if (/\.(mp3)$/i.test(lower)) return "audio/mpeg";
  if (/\.(wav)$/i.test(lower)) return "audio/wav";
  if (/\.(ogg)$/i.test(lower)) return "audio/ogg";
  if (/\.(webm)$/i.test(lower)) return "audio/webm";
  if (/\.(png)$/i.test(lower)) return "image/png";
  if (/\.(jpg|jpeg)$/i.test(lower)) return "image/jpeg";
  if (/\.(webp)$/i.test(lower)) return "image/webp";
  if (/\.(gif)$/i.test(lower)) return "image/gif";
  return type || "application/octet-stream";
}

  async function addFiles(files: File[]) {
    try {
      if (value.length + files.length > 3) throw new Error("You can attach up to 3 files per message.");
      const next = [...value];
      for (const file of files) {
        const rawMimeType = inferClientMimeType(file.name, file.type);
        const kind = rawMimeType.startsWith("image/") ? "image" : rawMimeType.startsWith("audio/") ? "audio" : "document";
        if (kind === "image" && file.size > IMAGE_LIMIT) throw new Error("Each image must be 5 MB or smaller.");
        if (kind === "audio" && file.size > AUDIO_LIMIT) throw new Error("Each audio file must be 15 MB or smaller.");
        if (kind === "document" && file.size > DOCUMENT_LIMIT) throw new Error("Each document must be 20 MB or smaller.");
        next.push({
          kind,
          clientId: crypto.randomUUID(),
          name: file.name || (kind === "image" ? "photo" : "voice-message.webm"),
          mimeType: kind === "audio" ? audioTypeAliases[rawMimeType] ?? rawMimeType : rawMimeType,
          dataBase64: await fileBase64(file),
        });
      }
      const totalBytes = next.reduce((total, item) => total + Math.floor(item.dataBase64.length * 0.75), 0);
      if (totalBytes > 20 * 1024 * 1024) throw new Error("Attachments in one message must be 20 MB or smaller in total.");
      onChange(next);
      onError("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not attach this file.");
    }
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    await addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }
  useEffect(() => {
    const form = attachmentRoot.current?.closest("form");
    if (!form) return;

    let dragDepth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const clearDragState = () => {
      dragDepth = 0;
      form.classList.remove("chat-file-dragging");
    };
    const onDragEnter = (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      form.classList.add("chat-file-dragging");
    };
    const onDragOver = (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) form.classList.remove("chat-file-dragging");
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      clearDragState();
      if (disabled) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void addFiles(files);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (disabled) return;
      const itemImages = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const images = itemImages.length > 0
        ? itemImages
        : Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      event.preventDefault();
      void addFiles(images);
    };

    form.addEventListener("dragenter", onDragEnter);
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("dragleave", onDragLeave);
    form.addEventListener("drop", onDrop);
    form.addEventListener("paste", onPaste);
    return () => {
      clearDragState();
      form.removeEventListener("dragenter", onDragEnter);
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("dragleave", onDragLeave);
      form.removeEventListener("drop", onDrop);
      form.removeEventListener("paste", onPaste);
    };
  }, [disabled, value, onChange, onError]);


  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Voice recording is not supported in this browser.");
      }
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(media, preferred ? { mimeType: preferred } : undefined);
      stream.current = media;
      recorder.current = active;
      chunks.current = [];
      active.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      active.onstop = () => {
        const mimeType = active.mimeType.split(";", 1)[0] || "audio/webm";
        const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunks.current, { type: mimeType });
        media.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        setRecording(false);
        void addFiles([new File([blob], "voice-message." + extension, { type: mimeType })]);
      };
      active.start(250);
      setRecording(true);
      onError("");
    } catch (error) {
      stream.current?.getTracks().forEach((track) => track.stop());
      setRecording(false);
      let message = "Could not access microphone.";
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        const name = error.name;
        if (name === "NotAllowedError" || msg.includes("permission denied") || msg.includes("permission dismissed")) {
          message = "Microphone access was denied by Windows or the browser. Please: 1) In Windows Settings (Privacy > Microphone), enable 'Allow apps to access your microphone'; 2) In the browser address bar, allow microphone access for this site.";
        } else if (name === "NotFoundError" || msg.includes("not found")) {
          message = "No microphone detected. Please check your microphone connection.";
        } else if (name === "NotReadableError" || msg.includes("in use")) {
          message = "Microphone is currently in use by another application.";
        } else {
          message = error.message || "Could not access microphone.";
        }
      }
      onError(message);
    }
  }

  return <section ref={attachmentRoot} className="chat-attachments" aria-label="Message attachments">
    {value.length > 0 && <div className="chat-attachment-tray">
      {value.map((item, index) => <div className="chat-attachment" key={index + item.name}>
        <AttachmentFileIcon item={item} />
        <span title={item.name}>{item.name}</span>
        <button type="button" aria-label={"Remove " + item.name} disabled={disabled}
          onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>×</button>
      </div>)}
    </div>}
    <div className="chat-attachment-actions">
      <div className="chat-add-wrap">
        <button type="button" className="chat-icon-button add" disabled={disabled || value.length >= 3}
          onClick={() => setMenuOpen((open) => !open)} title="Add photos and files" aria-label="Add photos and files" aria-expanded={menuOpen}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        {menuOpen && <div className="chat-add-menu">
          <button type="button" onClick={() => { setMenuOpen(false); imageInput.current?.click(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3" /></svg>
            <span><strong>Add photos</strong><small>JPG, PNG, WEBP or GIF</small></span>
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); documentInput.current?.click(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5" /></svg>
            <span><strong>Add document / table / archive</strong><small>Excel, PDF, Word, ZIP, CSV or code</small></span>
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); audioInput.current?.click(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13M9 9l10-2" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>
            <span><strong>Add audio file</strong><small>Upload from your computer</small></span>
          </button>
          <div className="chat-add-menu-divider" />
          <div className="chat-add-menu-item chat-add-menu-toggle-item">
            <label className="chat-add-menu-toggle-label">
              <input
                type="checkbox"
                checked={activePrivateRequest}
                onChange={(e) => handleTogglePrivateRequest(e.target.checked)}
              />
              <span className={`chat-menu-checkbox ${activePrivateRequest ? "checked" : ""}`} aria-hidden="true">
                {activePrivateRequest && (
                  <svg viewBox="0 0 24 24" width="12" height="12">
                    <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="chat-menu-toggle-title">Private request</span>
            </label>
          </div>
          <div className="chat-add-menu-item chat-add-menu-toggle-item chat-add-menu-tts-item">
            {!activeTtsEnabled ? (
              <label className="chat-add-menu-toggle-label chat-add-menu-tts-toggle">
                <input
                  type="checkbox"
                  checked={false}
                  onChange={(e) => handleToggleTts(e.target.checked)}
                />
                <span className="chat-menu-checkbox chat-tts-checkbox" aria-hidden="true" />
                <span className="chat-menu-toggle-title chat-tts-label">Text-to-Speech</span>
              </label>
            ) : (
              <div className="chat-add-menu-tts-active-row">
                <label className="chat-add-menu-checkbox-wrap" title="Disable Text-to-Speech">
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={() => handleToggleTts(false)}
                  />
                  <span className="chat-menu-checkbox chat-tts-checkbox checked" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12">
                      <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </label>
                <div className="chat-tts-voice-control">
                  <span className="chat-tts-voice-title">Voice</span>
                  <select
                    className="chat-tts-voice-select"
                    value={activeTtsVoice}
                    onChange={(e) => handleVoiceChange(e.target.value)}
                    aria-label="Speech voice"
                  >
                    {SPEECH_VOICES.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.label} - {voice.description}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
          {activeTtsEnabled && onGenerateSpeech && inputText?.trim() && (
            <button
              type="button"
              className="chat-add-menu-generate-btn"
              disabled={disabled || isGeneratingSpeech}
              onClick={() => {
                setMenuOpen(false);
                void onGenerateSpeech();
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
              <span>
                <strong>{isGeneratingSpeech ? "Generating speech…" : "Generate speech recording"}</strong>
                <small>Create audio from your current message</small>
              </span>
            </button>
          )}
        </div>}
      </div>
      <button type="button" className={"chat-icon-button microphone" + (recording ? " recording" : "")}
        disabled={disabled || (!recording && value.length >= 3)}
        onClick={() => void toggleRecording()} title={recording ? "Stop recording" : "Record voice message"}
        aria-label={recording ? "Stop voice recording" : "Record voice message"}>
        {recording
          ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>}
      </button>
      <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
        multiple hidden onChange={(event) => void pick(event)} />
      <input ref={audioInput} type="file"
        accept=".m4a,audio/x-m4a,audio/m4a,audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/flac"
        hidden onChange={(event) => void pick(event)} />
      <input ref={documentInput} type="file" accept=".pdf,.txt,.csv,.tsv,.json,.xml,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.tar,.gz" multiple hidden onChange={(event) => void pick(event)} />
    </div>
  </section>;
}

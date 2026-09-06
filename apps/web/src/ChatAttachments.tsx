import { useEffect, useRef, useState, type ChangeEvent } from "react";

export type ChatAttachmentInput = {
  kind: "image" | "audio" | "document" | "file";
  clientId?: string;
  name: string;
  mimeType: string;
  dataBase64: string;
};

export function PendingMessageAttachments({ value }: { value: ChatAttachmentInput[] }) {
  if (value.length === 0) return null;
  return <div className="chat-sent-attachments">
    {value.map((item, index) => item.kind === "image"
      ? <figure className="chat-message-attachment image" key={index + item.name}>
          <img src={"data:" + item.mimeType + ";base64," + item.dataBase64} alt={item.name} />
          <figcaption>{item.name}</figcaption>
        </figure>
      : item.kind === "audio"
        ? <figure className="chat-message-attachment audio" key={index + item.name}>
            <audio controls src={"data:" + item.mimeType + ";base64," + item.dataBase64} />
            <figcaption>{item.name}</figcaption>
          </figure>
        : <figure className="chat-message-attachment document" key={index + item.name}><strong>{item.name}</strong></figure>)}
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

export function ChatAttachments({ value, onChange, onError, disabled }: {
  value: ChatAttachmentInput[];
  onChange(value: ChatAttachmentInput[]): void;
  onError(message: string): void;
  disabled?: boolean;
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

  useEffect(() => () => stream.current?.getTracks().forEach((track) => track.stop()), []);

  async function addFiles(files: File[]) {
    try {
      if (value.length + files.length > 3) throw new Error("You can attach up to 3 files per message.");
      const next = [...value];
      for (const file of files) {
        const rawMimeType = file.type.toLowerCase().split(";", 1)[0] || (/\.m4a$/i.test(file.name) ? "audio/mp4" : "");
        const kind = rawMimeType.startsWith("image/") ? "image" : rawMimeType.startsWith("audio/") ? "audio" : rawMimeType ? "document" : null;
        if (!kind) throw new Error("The selected file type is unavailable.");
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
      onError(error instanceof Error ? error.message : "Microphone access failed.");
    }
  }

  return <section ref={attachmentRoot} className="chat-attachments" aria-label="Message attachments">
    {value.length > 0 && <div className="chat-attachment-tray">
      {value.map((item, index) => <div className="chat-attachment" key={index + item.name}>
        {item.kind === "image"
          ? <img src={"data:" + item.mimeType + ";base64," + item.dataBase64} alt={item.name} />
          : <span className="chat-audio-icon" aria-hidden="true">♪</span>}
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
            <span><strong>Add document</strong><small>PDF, Word, Excel, text or JSON</small></span>
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); audioInput.current?.click(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13M9 9l10-2" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>
            <span><strong>Add audio file</strong><small>Upload from your computer</small></span>
          </button>
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
      <input ref={documentInput} type="file" accept=".pdf,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" multiple hidden onChange={(event) => void pick(event)} />
    </div>
  </section>;
}

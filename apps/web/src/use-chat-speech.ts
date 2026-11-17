import { getStoredAuthToken } from "./AuthContext";
import { useState } from "react";
import { type ChatAttachmentInput } from "./ChatAttachments";
import type { Dispatch, SetStateAction } from "react";
/** Voice draft preferences and audio attachment generation for the chat composer. */
export function useChatSpeech(input: string, setAttachments: Dispatch<SetStateAction<ChatAttachmentInput[]>>, setNotice: (value: string) => void) {
    const [ttsVoice, setTtsVoice] = useState(() => {
        try {
            return localStorage.getItem("npati_chat_tts_voice") || "alloy";
        }
        catch {
            return "alloy";
        }
    });
    const [isGeneratingSpeech, setIsGeneratingSpeech] = useState(false);
    const handleTtsVoiceChange = (voice: string) => {
        setTtsVoice(voice);
        try {
            localStorage.setItem("npati_chat_tts_voice", voice);
        }
        catch { }
    };
    async function generateSpeechForInput(): Promise<void> {
        const text = input.trim();
        if (!text || isGeneratingSpeech)
            return;
        setIsGeneratingSpeech(true);
        try {
            const token = getStoredAuthToken();
            const response = await fetch("/api/audio/speech", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ input: text, format: "mp3", voice: ttsVoice }),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => null) as {
                    error?: {
                        message?: string;
                    } | string;
                } | null;
                throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? `TTS failed (${response.status})`);
            }
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            let binary = "";
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]!);
            }
            const base64Data = btoa(binary);
            const audioAttachment: ChatAttachmentInput = {
                name: `speech-${ttsVoice}.mp3`,
                mimeType: "audio/mpeg",
                kind: "audio",
                dataBase64: base64Data,
            };
            setAttachments((prev) => [...prev.filter((a) => a.name !== audioAttachment.name), audioAttachment]);
        }
        catch (err) {
            setNotice(err instanceof Error ? err.message : "Text-to-speech failed.");
        }
        finally {
            setIsGeneratingSpeech(false);
        }
    }
    return { ttsVoice, isGeneratingSpeech, handleTtsVoiceChange, generateSpeechForInput };
}

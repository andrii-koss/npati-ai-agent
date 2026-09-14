export type SpeechVoice = {
  id: string;
  label: string;
  description: string;
};

export const SPEECH_VOICES: readonly SpeechVoice[] = [
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

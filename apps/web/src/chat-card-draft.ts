import { useEffect, useRef, type MutableRefObject } from "react";

const changeDraftEvent = "npati:chat-card-change-draft";
export function requestCardChanges(title: string, selectedText: string, uk: boolean) {
  const text = `${uk ? "Внеси зміни у виділений фрагмент документа" : "Revise the selected passage in the document"} «${title}»:\n\n${selectedText.split("\n").map(line => `> ${line}`).join("\n")}\n\n${uk ? "Потрібні зміни" : "Requested changes"}: `;
  window.dispatchEvent(new CustomEvent(changeDraftEvent, { detail: { text } }));
}

export function useCardChangeDraft(input: string, setInput: (value: string) => void, disabled = false, draftVersion?: MutableRefObject<number>) {
  const latest = useRef({ input, setInput, disabled, draftVersion });
  latest.current = { input, setInput, disabled, draftVersion };
  useEffect(() => {
    const insert = (event: Event) => {
      const state = latest.current;
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (state.disabled || typeof text !== "string" || !text.trim()) return;
      if (state.draftVersion) ++state.draftVersion.current;
      state.setInput(state.input.trim() ? state.input.trimEnd() + "\n\n" + text : text);
      requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(".onboarding-live-composer textarea");
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    };
    window.addEventListener(changeDraftEvent, insert);
    return () => window.removeEventListener(changeDraftEvent, insert);
  }, []);
}

import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { nearChatBottom } from "./chat-timeline";

/** A scroll within this time of the user's own wheel, touch, key or pointer input is the user's scroll. */
const USER_INPUT_MS = 900;
const UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keeps the chat at the bottom while the agent works: its steps, code and reply grow inside the same message, which
 * the message-based scroll never saw, so the user had to scroll down again and again. Only the user's own scroll up
 * stops following (a smooth scroll the chat started itself must not), and coming back to the bottom resumes it.
 */
export function useChatFollowBottom(stream: RefObject<HTMLElement | null>, follow: MutableRefObject<boolean>, active: boolean) {
  const lastUserInput = useRef(0);
  const pointerDown = useRef(false);

  useEffect(() => {
    const element = stream.current;
    if (!active || !element || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const stick = () => {
      frame = 0;
      if (!follow.current) return;
      if (element.scrollHeight - element.scrollTop - element.clientHeight > 1) element.scrollTo({ top: element.scrollHeight, behavior: "instant" as ScrollBehavior });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(stick); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    // A row that opens or a card that grows changes the height without changing the DOM.
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    sizes?.observe(element);
    for (const child of Array.from(element.children)) sizes?.observe(child);
    element.addEventListener("transitionend", schedule);
    element.addEventListener("load", schedule, true);
    schedule();
    return () => {
      mutations.disconnect();
      sizes?.disconnect();
      element.removeEventListener("transitionend", schedule);
      element.removeEventListener("load", schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active, follow, stream]);

  useEffect(() => {
    const release = () => { pointerDown.current = false; };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  }, []);

  /** Wheel, touch, key and pointer handlers of the chat area call this; an upward wheel or key stops following at once. */
  const noteUserInput = useCallback((event?: { type: string; deltaY?: number; key?: string }) => {
    lastUserInput.current = Date.now();
    if (event?.type === "pointerdown") pointerDown.current = true;
    if ((event?.type === "wheel" && (event.deltaY ?? 0) < 0) || (event?.type === "keydown" && event.key && UPWARD_KEYS.has(event.key))) follow.current = false;
  }, [follow]);

  /** The chat area's scroll handler: back at the bottom follows again; the user's scroll away stops it. */
  const updateFollow = useCallback((element: HTMLElement) => {
    const user = pointerDown.current || Date.now() - lastUserInput.current < USER_INPUT_MS;
    // After the user's own scroll, only the very bottom resumes following: a small scroll up must stay where it is.
    if (user ? element.scrollHeight - element.scrollTop - element.clientHeight <= 24 : nearChatBottom(element)) follow.current = true;
    else if (user) follow.current = false;
  }, [follow]);

  return { noteUserInput, updateFollow };
}

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** Keep the opening reply in place while delayed history decorations and images arrive. */
export function useChatOpeningPosition(streamRef: RefObject<HTMLDivElement | null>, request: string | null, sending: boolean) {
  const current = useRef(request);
  const cancelled = useRef<string | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  current.current = request;

  const cancel = useCallback(() => {
    cancelled.current = current.current;
    observer.current?.disconnect();
  }, []);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const spacer = stream.querySelector<HTMLElement>(".chat-scroll-spacer");
    if (!request || sending) {
      if (spacer) spacer.style.minHeight = "";
      return;
    }
    if (cancelled.current === request) return;
    const align = () => {
      if (cancelled.current === request || current.current !== request) return;
      const rows = [...stream.querySelectorAll<HTMLElement>("article[data-message-id], article[data-chat-reply-id]")];
      let firstReply: HTMLElement | undefined, lastAnsweredTurn: HTMLElement | undefined;
      for (const row of rows) {
        if (row.classList.contains("user")) firstReply = undefined;
        else if (row.hasAttribute("data-chat-reply-id")) {
          firstReply ??= row;
          lastAnsweredTurn = firstReply;
        }
      }
      // A development reply can start with commentary, then operations and a saved summary.
      // Its beginning is the first text after the latest answered user turn, not the summary.
      const target = lastAnsweredTurn ?? [...rows].reverse().find(row => row.classList.contains("assistant")) ?? rows.at(-1);
      if (!target) return;
      // A short final reply also needs enough trailing space to reach the top.
      if (spacer) {
        const tail = spacer.getBoundingClientRect().top - target.getBoundingClientRect().top;
        const height = Math.max(24, stream.clientHeight - tail - 12);
        if (spacer.style.minHeight !== `${height}px`) spacer.style.minHeight = `${height}px`;
      }
      const top = Math.max(0, stream.scrollTop + target.getBoundingClientRect().top - stream.getBoundingClientRect().top - stream.clientTop - 12);
      if (Math.abs(top - stream.scrollTop) > 1) stream.scrollTo({ top, behavior: "instant" as ScrollBehavior });
    };
    align();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(align);
    observer.current = resize;
    resize.observe(stream);
    for (const child of stream.children) if (!child.classList.contains("chat-scroll-spacer")) resize.observe(child);
    return () => { resize.disconnect(); if (observer.current === resize) observer.current = null; };
  });

  return cancel;
}

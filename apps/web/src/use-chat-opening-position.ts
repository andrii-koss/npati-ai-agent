import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** Open every conversation at its bottom, including late cards, activity and images. */
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
    if (spacer) spacer.style.minHeight = "";
    if (!request || sending) {
      return;
    }
    if (cancelled.current === request) return;
    const align = () => {
      if (cancelled.current === request || current.current !== request) return;
      // Include the summary, project card and total-time footer, not just a text row.
      const top = Math.max(0, stream.scrollHeight - stream.clientHeight);
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

import { useRef, useState, useEffect, useCallback } from "react";
import { isChatProgressEvent } from "./chat-stream";
import type { ChatProgressEvent } from "./ResearchProgress";

const PAGE_PROGRESS_PRESENTATION_MS = 1200;

export function useChatResearchProgress(flushDeltasRef: React.MutableRefObject<(() => void) | null>) {
  const [progressEvents, setProgressEvents] = useState<ChatProgressEvent[]>([]);
  const [visibleProgressCount, setVisibleProgressCount] = useState(0);
  const [presentingProgressEvent, setPresentingProgressEvent] = useState<ChatProgressEvent | null>(null);
  const [progressComplete, setProgressComplete] = useState(false);
  const [progressFailed, setProgressFailed] = useState(false);
  const progressCompleteRef = useRef(false);
  const progressEventsRef = useRef<ChatProgressEvent[]>([]);
  const progressQueueRef = useRef<ChatProgressEvent[]>([]);
  const pendingSearchResultsRef = useRef<ChatProgressEvent | null>(null);
  const pageStartPendingRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);
  const nextProgressRevealRef = useRef(0);

  const drainProgressQueue = useCallback(() => {
    const delay = Math.max(0, nextProgressRevealRef.current - Date.now());
    progressTimerRef.current = window.setTimeout(() => {
      const next = progressQueueRef.current[0];
      if (!next) {
        progressTimerRef.current = null;
        if (progressEventsRef.current.some((e) => !e.type.startsWith("final_generation"))) {
          progressCompleteRef.current = true;
          setProgressComplete(true);
          flushDeltasRef.current?.();
        }
        return;
      }
      const isPageResult = next.type === "page_fetch_completed" || next.type === "page_fetch_failed";
      if (isPageResult) {
        setPresentingProgressEvent(next);
        progressTimerRef.current = window.setTimeout(() => {
          progressQueueRef.current.shift();
          setVisibleProgressCount((count) => count + 1);
          setPresentingProgressEvent(null);
          nextProgressRevealRef.current = Date.now() + 250;
          progressTimerRef.current = null;
          if (progressQueueRef.current.length > 0) {
            drainProgressQueue();
          } else {
            progressCompleteRef.current = true;
            setProgressComplete(true);
            flushDeltasRef.current?.();
          }
        }, PAGE_PROGRESS_PRESENTATION_MS);
        return;
      }
      progressQueueRef.current.shift();
      setVisibleProgressCount((count) => count + 1);
      nextProgressRevealRef.current = Date.now() + (next.type === "search_results_received" ? 0 : 800);
      progressTimerRef.current = null;
      if (progressQueueRef.current.length > 0) {
        drainProgressQueue();
      } else {
        progressCompleteRef.current = true;
        setProgressComplete(true);
        flushDeltasRef.current?.();
      }
    }, delay);
  }, [flushDeltasRef]);

  const queueProgressEvent = useCallback((event: ChatProgressEvent) => {
    const nextEvents = [...progressEventsRef.current, event];
    progressEventsRef.current = nextEvents;
    setProgressEvents(nextEvents);
    progressQueueRef.current.push(event);
    if (progressTimerRef.current === null) drainProgressQueue();
  }, [drainProgressQueue]);

  const enqueueProgress = useCallback((event: ChatProgressEvent) => {
    if (!isChatProgressEvent(event) || event.type === "source_discovered") return;
    if (event.type === "search_results_received") {
      pendingSearchResultsRef.current = event;
      return;
    }
    if (event.type === "page_fetch_started" && pendingSearchResultsRef.current) return;
    if (
      pendingSearchResultsRef.current
      && (event.type === "page_fetch_completed" || event.type === "page_fetch_failed" || event.type === "research_completed")
    ) {
      queueProgressEvent(pendingSearchResultsRef.current);
      pendingSearchResultsRef.current = null;
    }
    if (event.type === "page_fetch_started") {
      if (pageStartPendingRef.current && event.domain !== "file") return;
      if (event.domain !== "file") pageStartPendingRef.current = true;
    }
    if (event.type === "page_fetch_completed" || event.type === "page_fetch_failed" || event.type === "research_completed") {
      pageStartPendingRef.current = false;
    }
    queueProgressEvent(event);
  }, [queueProgressEvent]);

  const resetProgress = useCallback(() => {
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = null;
    progressQueueRef.current = [];
    progressEventsRef.current = [];
    pendingSearchResultsRef.current = null;
    pageStartPendingRef.current = false;
    setPresentingProgressEvent(null);
    nextProgressRevealRef.current = 0;
    setProgressEvents([]);
    setVisibleProgressCount(0);
    setProgressComplete(false);
    setProgressFailed(false);
    progressCompleteRef.current = false;
  }, []);

  const markComplete = useCallback(() => {
    progressCompleteRef.current = true;
    setProgressComplete(true);
  }, []);

  useEffect(() => () => {
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
  }, []);

  return {
    progressEvents,
    visibleProgressCount,
    presentingProgressEvent,
    progressComplete,
    progressFailed,
    setProgressComplete,
    setProgressFailed,
    markComplete,
    enqueueProgress,
    resetProgress,
    progressCompleteRef,
    progressEventsRef,
  };
}

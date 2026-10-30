import React, { useEffect, useState, useCallback } from "react";

export const SPLIT_STORAGE_KEY = "npati_live_preview_split_ratio";
export const DEFAULT_CHAT_RATIO = 40;
export const MIN_CHAT_RATIO = 25;
export const MAX_CHAT_RATIO = 75;

export interface LivePreviewSplitResizerProps {
  onSplitChange?: (ratio: number) => void;
  disabled?: boolean;
}

export function LivePreviewSplitResizer({
  onSplitChange,
  disabled = false,
}: LivePreviewSplitResizerProps) {
  const [ratio, setRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(SPLIT_STORAGE_KEY);
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= MIN_CHAT_RATIO && val <= MAX_CHAT_RATIO) {
          return val;
        }
      }
    } catch {
      // Fallback to default
    }
    return DEFAULT_CHAT_RATIO;
  });

  const [isDragging, setIsDragging] = useState(false);

  // Sync ratio to CSS custom properties on documentElement
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-split-ratio", `${ratio}%`);
    document.documentElement.style.setProperty("--preview-split-ratio", `${100 - ratio}%`);
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(ratio * 10) / 10));
    } catch {
      // Ignore localStorage errors
    }
    onSplitChange?.(ratio);
  }, [ratio, onSplitChange]);

  const resetToDefault = useCallback(() => {
    setRatio(DEFAULT_CHAT_RATIO);
  }, []);

  const handlePointerDown = useCallback((startX: number) => {
    if (disabled) return;
    setIsDragging(true);
    document.body.classList.add("is-resizing");

    const onMove = (e: MouseEvent | TouchEvent) => {
      const currentX = "touches" in e ? e.touches[0]?.clientX ?? startX : e.clientX;
      const totalWidth = window.innerWidth;
      if (totalWidth <= 0) return;
      let newRatio = (currentX / totalWidth) * 100;
      if (newRatio < MIN_CHAT_RATIO) newRatio = MIN_CHAT_RATIO;
      if (newRatio > MAX_CHAT_RATIO) newRatio = MAX_CHAT_RATIO;
      setRatio(newRatio);
    };

    const onEnd = () => {
      setIsDragging(false);
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
  }, [disabled]);

  if (disabled) return null;

  return (
    <>
      {isDragging && <div className="project-chat-preview-iframe-drag-shield" aria-hidden="true" />}
      <div
        className={`project-chat-preview-resizer ${isDragging ? "is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio)}
        aria-valuemin={MIN_CHAT_RATIO}
        aria-valuemax={MAX_CHAT_RATIO}
        aria-label="Resize panels"
        data-testid="live-preview-split-resizer"
        tabIndex={0}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          handlePointerDown(e.clientX);
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (touch) {
            handlePointerDown(touch.clientX);
          }
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          resetToDefault();
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 5 : 1;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setRatio((prev) => Math.max(MIN_CHAT_RATIO, prev - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setRatio((prev) => Math.min(MAX_CHAT_RATIO, prev + step));
          } else if (e.key === "Home" || e.key === "Enter") {
            e.preventDefault();
            resetToDefault();
          }
        }}
      >
        <div className="project-chat-preview-resizer-line" aria-hidden="true" />
        <div className="project-chat-preview-resizer-grip" aria-hidden="true" />
      </div>
    </>
  );
}

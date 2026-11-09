import React, { useState } from "react";

export type PreviewSide = "right" | "left";
const STORAGE_KEY = "npati_live_preview_side";

export function readPreviewSide(): PreviewSide {
  try { return localStorage.getItem(STORAGE_KEY) === "left" ? "left" : "right"; } catch { return "right"; }
}

function applyPreviewSide(side: PreviewSide) {
  document.documentElement.dataset.previewSide = side;
}
if (typeof document !== "undefined") applyPreviewSide(readPreviewSide());

/** Swaps the side panel and the chat; the choice stays for later panels and page loads. */
export function PreviewSideButton({ isUk }: { isUk: boolean }) {
  const [side, setSide] = useState(readPreviewSide);
  const toRight = side === "left";
  const label = toRight ? (isUk ? "Перемістити праворуч" : "Move to the right") : (isUk ? "Перемістити ліворуч" : "Move to the left");
  function swap() {
    const next: PreviewSide = toRight ? "right" : "left";
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The swap still applies to this page. */ }
    applyPreviewSide(next);
    setSide(next);
  }
  return (
    <span className="preview-side-control">
      <button type="button" className={`marketplace-back-button preview-side-button ${toRight ? "points-right" : ""}`} onClick={swap} aria-label={label} title={label}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={toRight ? "M5 12h14M12 5l7 7-7 7" : "M19 12H5M12 19l-7-7 7-7"} />
        </svg>
      </button>
      <div className="preview-header-divider" aria-hidden="true" />
    </span>
  );
}

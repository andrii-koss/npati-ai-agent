import React, { type TextareaHTMLAttributes, useEffect, useLayoutEffect, useRef } from "react";

export function AutoResizeChatTextarea({ value, onInput, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const syncHeightAndSwitcher = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // 1. Auto resize height
    const maxHeight = Math.min(Math.max(window.innerHeight * 0.52, 180), 520);
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 56), maxHeight);
    textarea.style.height = nextHeight + "px";
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";

    // 2. Compact switcher detection
    const form = textarea.closest(".onboarding-live-composer");
    const switcher = form?.querySelector(".composer-context-switcher") as HTMLElement | null;
    if (!form || !switcher) return;

    const rawText = textarea.value || String(value ?? "");
    if (!rawText.trim()) {
      form.classList.remove("has-compact-context");
      switcher.classList.remove("is-compact");
      return;
    }

    const isMultiLine = textarea.scrollHeight > 62 || rawText.includes("\n");
    const firstLine = rawText.split("\n")[0] || "";
    const isMobile = window.innerWidth <= 768;
    const charThreshold = isMobile ? 26 : 50;
    const isCurrentlyCompact = form.classList.contains("has-compact-context");

    const reachesBlock = isMultiLine || (isCurrentlyCompact ? firstLine.length >= charThreshold - 6 : firstLine.length >= charThreshold);

    if (reachesBlock) {
      form.classList.add("has-compact-context");
      switcher.classList.add("is-compact");
    } else {
      form.classList.remove("has-compact-context");
      switcher.classList.remove("is-compact");
    }
  };

  useLayoutEffect(() => {
    syncHeightAndSwitcher();
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleInput = () => {
      syncHeightAndSwitcher();
    };

    textarea.addEventListener("input", handleInput);
    window.addEventListener("resize", syncHeightAndSwitcher);

    return () => {
      textarea.removeEventListener("input", handleInput);
      window.removeEventListener("resize", syncHeightAndSwitcher);
    };
  }, []);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onInput={(e) => {
        syncHeightAndSwitcher();
        onInput?.(e);
      }}
      {...props}
    />
  );
}



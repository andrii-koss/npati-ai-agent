import React, { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

export function AutoResizeChatTextarea({ value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = Math.min(Math.max(window.innerHeight * 0.52, 180), 520);
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 56), maxHeight);
    textarea.style.height = nextHeight + "px";
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  return <textarea ref={textareaRef} value={value} {...props} />;
}

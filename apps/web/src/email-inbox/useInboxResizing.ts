import { useEffect, useState } from "react";

export function useInboxResizing(sidebarCollapsed: boolean) {
  const [threadsWidth, setThreadsWidth] = useState<number>(300);
  const [isResizing, setIsResizing] = useState(false);
  const [historyHeight, setHistoryHeight] = useState(140);
  const [isResizingHistory, setIsResizingHistory] = useState(false);

  const startHistoryResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingHistory(true);
  };

  useEffect(() => {
    if (!isResizingHistory) return;
    const handleMouseMove = (e: MouseEvent) => {
      const composerEl = document.querySelector(".email-inbox-composer");
      if (!composerEl) return;
      const composerRect = composerEl.getBoundingClientRect();
      const newHeight = composerRect.top - e.clientY;
      if (newHeight >= 60 && newHeight <= 450) {
        setHistoryHeight(newHeight);
      }
    };
    const handleMouseUp = () => {
      setIsResizingHistory(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingHistory]);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const card = document.querySelector(".email-inbox-card");
      if (!card) return;
      const cardRect = card.getBoundingClientRect();
      const sidebarWidth = sidebarCollapsed ? 58 : 190;
      const newWidth = e.clientX - cardRect.left - sidebarWidth;
      if (newWidth >= 220 && newWidth <= 520) {
        setThreadsWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, sidebarCollapsed]);

  return {
    threadsWidth,
    isResizing,
    startResizing,
    historyHeight,
    setHistoryHeight,
    startHistoryResizing,
  };
}

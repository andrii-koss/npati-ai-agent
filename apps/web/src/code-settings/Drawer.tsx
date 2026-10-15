import React, { useEffect } from "react";

export interface DrawerProps {
  title: string;
  subtitle: string;
  closeLabel: string;
  isUk: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function Drawer({ title, subtitle, closeLabel, isUk, onClose, children }: DrawerProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="company-drawer-backdrop" onMouseDown={() => onClose()}>
      <aside
        className="company-drawer automations-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{subtitle}</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="automations-drawer-close"
            aria-label={isUk ? "Закрити" : "Close"}
            title={closeLabel}
            onClick={onClose}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

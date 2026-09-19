import React, { useState, useRef, useEffect } from "react";
import { useTranslation, SupportedLanguage } from "./i18n";

export interface LanguageSwitcherProps {
  className?: string;
  variant?: "compact" | "full" | "settings";
}

export function LanguageSwitcher({ className = "", variant = "compact" }: LanguageSwitcherProps) {
  const { language, languageInfo, supportedLanguages, changeLanguage } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (variant === "settings") {
    return (
      <div className={`npati-language-settings-grid ${className}`}>
        {supportedLanguages.map((item) => {
          const isCurrent = item.code === language;
          return (
            <button
              key={item.code}
              type="button"
              className={`npati-language-card-option ${isCurrent ? "active" : ""}`}
              onClick={() => changeLanguage(item.code)}
            >
              <span className="npati-language-flag">{item.flag}</span>
              <div className="npati-language-info">
                <span className="npati-language-native">{item.nativeName}</span>
                <span className="npati-language-english">{item.name}</span>
              </div>
              {isCurrent && <span className="npati-language-active-dot" />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`npati-language-switcher ${className}`} ref={dropdownRef}>
      <button
        type="button"
        className={`npati-language-trigger ${isOpen ? "open" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Change language"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="npati-language-globe">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
        <span className="npati-language-current-label">
          {variant === "full" ? `${languageInfo.flag} ${languageInfo.nativeName}` : languageInfo.code.toUpperCase()}
        </span>
        <svg
          className={`npati-language-chevron ${isOpen ? "rotated" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className="npati-language-dropdown" role="listbox">
          <div className="npati-language-dropdown-header">Select Language</div>
          {supportedLanguages.map((item) => {
            const isCurrent = item.code === language;
            return (
              <button
                key={item.code}
                type="button"
                role="option"
                aria-selected={isCurrent}
                className={`npati-language-item ${isCurrent ? "active" : ""}`}
                onClick={() => {
                  changeLanguage(item.code);
                  setIsOpen(false);
                }}
              >
                <span className="npati-language-flag">{item.flag}</span>
                <span className="npati-language-names">
                  <span className="npati-language-primary">{item.nativeName}</span>
                  <span className="npati-language-secondary">{item.name}</span>
                </span>
                {isCurrent && <span className="npati-language-active-dot" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

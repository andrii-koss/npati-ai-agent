import React from "react";
import type { DeviceMode, PreviewStatusResponse } from "../types";

interface PreviewColumnProps {
  language: string;
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  setIframeKey: React.Dispatch<React.SetStateAction<number>>;
  previewStatus: PreviewStatusResponse | null;
  previewLoading: boolean;
  handleStartPreview: () => void;
  iframeKey: number;
  deviceWidthStyle: React.CSSProperties;
}

export function PreviewColumn({
  language,
  deviceMode,
  setDeviceMode,
  setIframeKey,
  previewStatus,
  previewLoading,
  handleStartPreview,
  iframeKey,
  deviceWidthStyle,
}: PreviewColumnProps) {
  return (
    <section className="project-col project-col-preview" aria-label="Live Preview">
      <div className="col-header preview-col-header">
        <h3>{language === "uk" ? "Live Preview" : "Live Preview"}</h3>
        <div className="device-mode-toggles">
          <button
            type="button"
            className={`device-btn ${deviceMode === "desktop" ? "active" : ""}`}
            onClick={() => setDeviceMode("desktop")}
            title="Desktop (100%)"
          >
            🖥️
          </button>
          <button
            type="button"
            className={`device-btn ${deviceMode === "tablet" ? "active" : ""}`}
            onClick={() => setDeviceMode("tablet")}
            title="Tablet (768px)"
          >
            📱 Tab
          </button>
          <button
            type="button"
            className={`device-btn ${deviceMode === "mobile" ? "active" : ""}`}
            onClick={() => setDeviceMode("mobile")}
            title="Mobile (375px)"
          >
            📱 Mobile
          </button>
          <button
            type="button"
            className="reload-iframe-btn"
            onClick={() => setIframeKey((k) => k + 1)}
            title="Reload Preview iframe"
          >
            🔄
          </button>
        </div>
      </div>

      <div className="preview-viewport-wrapper">
        {previewStatus?.error ? (
          <div className="preview-error-card">
            <h4>⚠️ {language === "uk" ? "Помилка dev server" : "Dev Server / Build Error"}</h4>
            <p>{previewStatus.error}</p>
            <button type="button" className="button-secondary" onClick={() => void handleStartPreview()}>
              {language === "uk" ? "Спробувати знову" : "Retry Server"}
            </button>
          </div>
        ) : previewStatus?.isRunning && previewStatus?.previewUrl ? (
          <div className="device-screen-container" style={deviceWidthStyle}>
            <iframe
              key={iframeKey}
              src={previewStatus.previewUrl}
              title="Website Preview"
              className="preview-iframe"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        ) : (
          <div className="preview-placeholder">
            <div className="placeholder-content">
              <span className="placeholder-icon">🌐</span>
              <h4>{language === "uk" ? "Preview не запущено" : "Preview is not running"}</h4>
              <p>
                {language === "uk"
                  ? "Натисніть «Запустити Preview» угорі або попросіть агента створити сайт."
                  : 'Click "Start Preview" above or prompt the agent to build the landing page.'}
              </p>
              <button
                type="button"
                className="button-primary"
                onClick={() => void handleStartPreview()}
                disabled={previewLoading}
              >
                {language === "uk" ? "▶ Запустити зараз" : "▶ Start Preview"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

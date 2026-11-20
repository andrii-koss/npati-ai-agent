import type { Dispatch, SetStateAction, ReactNode } from "react";
import type { flattenFiles } from "../code-workspace-page-types";
import { CodeView } from "../code-highlight";
interface Props {
  isUk: boolean;
  activeTab: string;
  tree: ReturnType<typeof flattenFiles>;
  filteredTree: ReturnType<typeof flattenFiles>;
  filesError: string | null;
  fileFilter: string;
  setFileFilter: (filter: string) => void;
  selectedPath: string;
  openFile: (path: string) => Promise<void>;
  renderFileIcon: (label: string) => ReactNode;
  isFullscreenFile: boolean;
  setIsFullscreenFile: Dispatch<SetStateAction<boolean>>;
  fileContent: string | null;
  isEditingFile: boolean;
  setIsEditingFile: Dispatch<SetStateAction<boolean>>;
  savingFile: boolean;
  saveFile: () => Promise<void>;
  copied: boolean;
  copyFileContent: () => void;
  fileError: string | null;
  setFileContent: (content: string) => void;
  saveSuccess: boolean;
}

export function CodeWorkspaceFilePanel({ isUk, activeTab, tree, filteredTree, filesError, fileFilter, setFileFilter, selectedPath, openFile, renderFileIcon, isFullscreenFile, setIsFullscreenFile, fileContent, isEditingFile, setIsEditingFile, savingFile, saveFile, copied, copyFileContent, fileError, setFileContent, saveSuccess }: Props) {
  return (
    <>
      {/* TAB 2: FILES & CODE (2-Column IDE) */}
      {(activeTab === "files" || activeTab === "all") && (
        <div className="project-grid-2col" style={{ display: "grid", gridTemplateColumns: activeTab === "all" ? undefined : "280px 1fr", gap: 16, marginBottom: 20 }}>
          {/* Files column */}
          <section className="project-col project-col-files" aria-label={isUk ? "Файли" : "Files"} style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div className="col-header">
              <h3 style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span>{isUk ? "Файли проєкту" : "Project files"}</span>
              </h3>
              <span className="file-count">{tree.length}</span>
            </div>

            <div className="file-search-form" style={{ padding: "8px 12px" }}>
              <div className="inspector-search-box" style={{ width: "100%", height: "36px", padding: "0 10px" }}>
                <span className="search-icon" aria-hidden="true" style={{ color: "#e11d2e", fontSize: "18px", lineHeight: 1, marginRight: "6px" }}>⌕</span>
                <input
                  type="text"
                  role="searchbox"
                  className="inspector-search-input"
                  placeholder={isUk ? "Фільтр файлів..." : "Filter files..."}
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  style={{ fontSize: "13px" }}
                  aria-label={isUk ? "Фільтр файлів" : "Filter files"}
                />
                {fileFilter && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => setFileFilter("")}
                    aria-label={isUk ? "Очистити" : "Clear"}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8" }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="file-tree-container" style={{ maxHeight: 480 }}>
              {filesError && <p className="ds-hint-error" style={{ padding: "8px 12px" }}>{filesError}</p>}
              {!filesError && filteredTree.length === 0 && (
                <p className="ds-muted" style={{ padding: "16px 12px", textAlign: "center", fontSize: "13px" }}>
                  {tree.length === 0
                    ? isUk ? "Файли ще не завантажено." : "No files loaded yet."
                    : isUk ? "Файлів за фільтром не знайдено." : "No files match the filter."}
                </p>
              )}
              <ul className="code-file-tree">
                {filteredTree.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`code-file-tree-item ${selectedPath === file.path ? "active" : ""}`}
                      style={{ paddingLeft: `${10 + file.depth * 14}px` }}
                      onClick={() => void openFile(file.path)}
                    >
                      <span className="file-icon">{renderFileIcon(file.label)}</span>
                      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {file.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* File viewer column */}
          <section
            className="project-col project-col-preview"
            aria-label={isUk ? "Файл" : "File"}
            style={
              isFullscreenFile
                ? {
                    position: "fixed",
                    top: 0,
                    left: 0,
                    width: "100vw",
                    height: "100vh",
                    zIndex: 99999,
                    background: "#fff",
                    borderRadius: 0,
                    border: "none",
                    margin: 0,
                    padding: "20px",
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                  }
                : {
                    border: "1px solid #e2e8f0",
                    borderRadius: 12,
                    background: "#fff",
                    overflow: "hidden",
                  }
            }
          >
            <div className="col-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ display: "inline-flex", alignItems: "center", gap: "6px", margin: 0 }}>
                {renderFileIcon(selectedPath || "")}
                <span>{selectedPath || (isUk ? "Виберіть файл" : "Select a file")}</span>
              </h3>
              {fileContent !== null && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  {/* Edit mode toggle */}
                  <button
                    type="button"
                    className={`button-secondary ${isEditingFile ? "active" : ""}`}
                    onClick={() => setIsEditingFile((prev) => !prev)}
                    style={{ padding: "4px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    title={isUk ? (isEditingFile ? "Перейти в режим читання" : "Редагувати файл вручну") : (isEditingFile ? "Read-only mode" : "Edit file manually")}
                    aria-label={isUk ? "Редагувати файл" : "Edit file"}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    <span>{isUk ? (isEditingFile ? "Читання" : "Редагувати") : (isEditingFile ? "View" : "Edit")}</span>
                  </button>

                  {/* Save button */}
                  {isEditingFile && (
                    <button
                      type="button"
                      className="button-primary"
                      onClick={() => void saveFile()}
                      disabled={savingFile}
                      style={{ padding: "4px 10px", fontSize: "11.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      title={isUk ? "Зберегти файл" : "Save file"}
                      aria-label={isUk ? "Зберегти" : "Save"}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <polyline points="17 21 17 13 7 13 7 21" />
                        <polyline points="7 3 7 8 15 8" />
                      </svg>
                      <span>{savingFile ? "…" : isUk ? "Зберегти" : "Save"}</span>
                    </button>
                  )}

                  {/* Fullscreen toggle button */}
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setIsFullscreenFile((prev) => !prev)}
                    style={{ padding: "4px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center" }}
                    title={isUk ? (isFullscreenFile ? "Згорнути екран" : "Розгорнути на весь екран") : (isFullscreenFile ? "Exit fullscreen" : "Fullscreen")}
                    aria-label={isUk ? "На весь екран" : "Fullscreen"}
                  >
                    {isFullscreenFile ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 14 10 14 10 20" />
                        <polyline points="20 10 14 10 14 4" />
                        <line x1="14" y1="10" x2="21" y2="3" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    )}
                  </button>

                  {/* Copy button */}
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={copyFileContent}
                    style={{ padding: "4px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center" }}
                    title={isUk ? "Скопіювати код у буфер" : "Copy code to clipboard"}
                    aria-label={isUk ? "Копіювати код" : "Copy code"}
                  >
                    {copied ? (
                      <span style={{ color: "#16a34a" }}>✓</span>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
              )}
            </div>

            <div className="project-file-viewer-body" style={{ minHeight: isFullscreenFile ? "calc(100vh - 140px)" : 420, flex: isFullscreenFile ? 1 : undefined, display: "flex", flexDirection: "column" }}>
              {fileError && <p className="ds-hint-error" style={{ margin: "16px" }}>{fileError}</p>}
              {!selectedPath && (
                <div className="code-empty-state" style={{ color: "#94a3b8", margin: "auto 0" }}>
                  <div className="code-empty-state-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                      <polyline points="13 2 13 9 20 9" />
                    </svg>
                  </div>
                  <h4 style={{ color: "#1e293b" }}>{isUk ? "Файл не вибрано" : "No file selected"}</h4>
                  <p>
                    {isUk
                      ? "Виберіть будь-який файл з лівої колонки, щоб переглянути його повний вміст."
                      : "Select any file from the left column to view its source code."}
                  </p>
                </div>
              )}
              {fileContent !== null && (
                isEditingFile ? (
                  <textarea
                    className="project-file-browser-textarea"
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    spellCheck={false}
                    style={{
                      width: "100%",
                      height: isFullscreenFile ? "calc(100vh - 160px)" : "480px",
                      flex: isFullscreenFile ? 1 : undefined,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: "13px",
                      lineHeight: "1.5",
                      border: "1px solid #cbd5e1",
                      outline: "none",
                      resize: "none",
                      padding: "16px",
                      background: "#0f172a",
                      color: "#f8fafc",
                      borderRadius: 8,
                      boxSizing: "border-box",
                    }}
                  />
                ) : (
                  <div
                    className="workspace-source-viewer"
                    style={{
                      maxHeight: isFullscreenFile ? "calc(100vh - 160px)" : 480,
                      height: isFullscreenFile ? "calc(100vh - 160px)" : undefined,
                      flex: 1,
                    }}
                  >
                    <CodeView text={fileContent} path={selectedPath} preserveSource />
                  </div>
                )
              )}
            </div>

            <div className="project-preview-col-footer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span>{isEditingFile ? "✏️ " + (isUk ? "Режим редагування" : "Manual edit mode") : (isUk ? "Режим читання (Read-only)" : "Read-only mode")}</span>
                <span style={{ marginLeft: "12px", color: isEditingFile ? "#0284c7" : undefined }}>
                  {isEditingFile
                    ? (isUk ? "Внесіть зміни та збережіть файл" : "Modify code and click Save")
                    : (isUk ? "Правки вносить AI-агент" : "Edits executed via agent")}
                </span>
              </div>
              {saveSuccess && (
                <span style={{ color: "#16a34a", fontWeight: 600, fontSize: "12px" }}>
                  ✓ {isUk ? "Файл збережено!" : "File saved!"}
                </span>
              )}
            </div>
          </section>
        </div>
      )}


    </>
  );
}

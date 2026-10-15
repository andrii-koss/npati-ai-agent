import React from "react";
import type { FileContent, FileEntry } from "../types";

interface FilesColumnProps {
  language: string;
  files: FileEntry[];
  fileSearchQuery: string;
  setFileSearchQuery: (v: string) => void;
  handleFileSearch: (e: React.FormEvent) => void;
  selectedFile: FileContent | null;
  openFile: (path: string) => void;
  onCloseFile: () => void;
}

export function FilesColumn({
  language,
  files,
  fileSearchQuery,
  setFileSearchQuery,
  handleFileSearch,
  selectedFile,
  openFile,
  onCloseFile,
}: FilesColumnProps) {
  return (
    <aside className="project-col project-col-files" aria-label="Project files">
      <div className="col-header">
        <h3>{language === "uk" ? "Файли" : "Files"}</h3>
        <span className="file-count">{files.length}</span>
      </div>

      <form onSubmit={handleFileSearch} className="file-search-form">
        <input
          value={fileSearchQuery}
          onChange={(e) => setFileSearchQuery(e.target.value)}
          placeholder={language === "uk" ? "Шукати файл…" : "Search files…"}
          className="file-search-input"
        />
      </form>

      <div className="file-tree-container">
        {files.length === 0 ? (
          <p className="no-files-hint">{language === "uk" ? "Файлів ще немає" : "No files yet"}</p>
        ) : (
          files.map((entry) => (
            <div key={entry.path} className="file-tree-row">
              {entry.type === "file" ? (
                <button
                  type="button"
                  className={`file-row-btn ${selectedFile?.path === entry.path ? "active" : ""}`}
                  onClick={() => openFile(entry.path)}
                  style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length * 12, 120)}px` }}
                >
                  📄 {entry.name}
                </button>
              ) : (
                <div
                  className="dir-row"
                  style={{ paddingInlineStart: `${Math.min(entry.path.split("/").length * 12, 120)}px` }}
                >
                  📁 {entry.name}/
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {selectedFile && (
        <div className="file-quick-viewer">
          <div className="quick-viewer-header">
            <span>{selectedFile.path}</span>
            <button type="button" onClick={onCloseFile}>
              ✕
            </button>
          </div>
          <pre>
            <code>{selectedFile.content}</code>
          </pre>
        </div>
      )}
    </aside>
  );
}

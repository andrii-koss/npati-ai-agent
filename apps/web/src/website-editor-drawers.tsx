import React from "react";
import { IconSparkles, IconFile, IconGrip } from "./website-editor-icons";
import {
  type ActiveDrawer,
  type FileEntry,
  type CheckpointItem,
  apiGet,
  apiPost,
} from "./website-editor-support";
import { promptModal } from "./ConfirmDialog";

export interface WebsiteEditorDrawersProps {
  activeDrawer: ActiveDrawer;
  setActiveDrawer: (drawer: ActiveDrawer) => void;
  chatMessages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  chatInput: string;
  setChatInput: (val: string) => void;
  chatBusy: boolean;
  handleSendChat: (e: React.FormEvent) => void;
  files: FileEntry[];
  selectedFilePath: string;
  setSelectedFilePath: (path: string) => void;
  fileContent: string;
  setFileContent: (content: string) => void;
  base: string;
  checkpoints: CheckpointItem[];
  setCheckpoints: React.Dispatch<React.SetStateAction<CheckpointItem[]>>;
}

export function WebsiteEditorDrawers({
  activeDrawer,
  setActiveDrawer,
  chatMessages,
  chatInput,
  setChatInput,
  chatBusy,
  handleSendChat,
  files,
  selectedFilePath,
  setSelectedFilePath,
  fileContent,
  setFileContent,
  base,
  checkpoints,
  setCheckpoints,
}: WebsiteEditorDrawersProps) {
  if (!activeDrawer) return null;

  return (
    <div className="npati-builder-drawer-backdrop" onClick={() => setActiveDrawer(null)}>
      <div className="npati-builder-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="npati-builder-drawer-header">
          <h3>
            {activeDrawer === "ai" && <><IconSparkles /> AI Developer Agent</>}
            {activeDrawer === "files" && <><IconFile /> Project Files</>}
            {activeDrawer === "history" && <><IconGrip /> Checkpoints & Git</>}
          </h3>
          <button
            type="button"
            className="npati-builder-row-action-btn"
            onClick={() => setActiveDrawer(null)}
            style={{ fontSize: "18px", color: "#64748b" }}
          >
            ✕
          </button>
        </div>

        <div className="npati-builder-drawer-body">
          {/* DRAWER: AI CHAT */}
          {activeDrawer === "ai" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px", marginBottom: "12px" }}>
                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      background: msg.role === "user" ? "#0f172a" : "#f1f5f9",
                      color: msg.role === "user" ? "#ffffff" : "#0f172a",
                      borderRadius: "10px",
                      padding: "10px 14px",
                      maxWidth: "85%",
                      fontSize: "13.5px",
                      lineHeight: 1.5,
                    }}
                  >
                    {msg.content}
                  </div>
                ))}
              </div>

              <form onSubmit={(e) => void handleSendChat(e)}>
                <input
                  type="text"
                  className="npati-builder-input"
                  placeholder="Ask AI to modify sections, change styles..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatBusy}
                />
              </form>
            </div>
          )}

          {/* DRAWER: FILES */}
          {activeDrawer === "files" && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "16px" }}>
                {files.map((f) => (
                  <div
                    key={f.path}
                    onClick={async () => {
                      setSelectedFilePath(f.path);
                      try {
                        const res = await apiGet<{ content: string }>(`${base}/files/read?path=${encodeURIComponent(f.path)}`);
                        setFileContent(res.content);
                      } catch {}
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                      background: selectedFilePath === f.path ? "#fef2f2" : "#ffffff",
                      color: selectedFilePath === f.path ? "#e11d2e" : "#0f172a",
                      border: "1px solid #e2e8f0",
                      fontWeight: 500,
                    }}
                  >
                    {f.path}
                  </div>
                ))}
              </div>

              {fileContent && (
                <pre style={{ background: "#0f172a", color: "#f8fafc", padding: "12px", borderRadius: "8px", fontSize: "12px", overflowX: "auto", maxHeight: "300px" }}>
                  {fileContent}
                </pre>
              )}
            </div>
          )}

          {/* DRAWER: HISTORY */}
          {activeDrawer === "history" && (
            <div>
              <button
                type="button"
                className="button-primary"
                style={{ width: "100%", marginBottom: "16px" }}
                onClick={async () => {
                  const name = await promptModal({ message: "Checkpoint name:" });
                  if (!name) return;
                  await apiPost(`${base}/checkpoints`, { name: name.trim() });
                  const res = await apiGet<{ checkpoints: CheckpointItem[] }>(`${base}/checkpoints`);
                  setCheckpoints(res.checkpoints || []);
                }}
              >
                + Create Checkpoint
              </button>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {checkpoints.length === 0 ? (
                  <p style={{ color: "#64748b", fontSize: "13px" }}>No checkpoints saved yet.</p>
                ) : (
                  checkpoints.map((cp) => (
                    <div key={cp.id} style={{ padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
                      <strong style={{ fontSize: "13.5px", color: "#0f172a" }}>{cp.name}</strong>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>{new Date(cp.createdAt).toLocaleString()}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

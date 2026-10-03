import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import {
  COMPONENT_REGISTRY,
  createDefaultWebsiteDocument,
  getWebsiteAdapter,
  type WebsiteDocument,
  type WebsitePage,
  type WebsiteBlock,
  type WebsiteBlockType,
  type BlockStyles,
} from "@npati/shared";

type DeviceMode = "desktop" | "tablet" | "mobile";
type EditorTab = "blocks" | "pages" | "theme" | "assets" | "chat" | "history" | "code" | "changes" | "seo" | "deploy";

interface PreviewStatusResponse {
  status: string;
  previewUrl?: string | null;
  port?: number | null;
  framework?: string | null;
  lastBuildStatus?: string | null;
  isRunning: boolean;
  error: string | null;
  restartCount: number;
}

interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
}

interface CheckpointItem {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  fileCount: number;
  createdAt: string;
}

interface DeploymentItem {
  id: string;
  provider: string;
  environment: string;
  status: string;
  targetUrl?: string;
  createdAt: string;
}

function authHeaders() {
  const value = new Headers();
  const token = getStoredAuthToken();
  if (token) value.set("Authorization", "Bearer " + token);
  return value;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {}
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

export function WebsiteEditor() {
  const { companyId = "", projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { language } = useTranslation();

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

  // Core Document Model state
  const [doc, setDoc] = useState<WebsiteDocument | null>(null);
  const [activePageId, setActivePageId] = useState<string>("page-home");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Undo / Redo history stack
  const [history, setHistory] = useState<WebsiteDocument[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // UI state
  const [activeTab, setActiveTab] = useState<EditorTab>((searchParams.get("tab") as EditorTab) || "blocks");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving">("saved");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Preview state
  const [previewStatus, setPreviewStatus] = useState<PreviewStatusResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  // Assets state
  const [uploadingAsset, setUploadingAsset] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([
    {
      id: "initial-assistant",
      role: "assistant",
      content: language === "uk"
        ? "Привіт! Я ваш AI Developer Agent. Ви можете попросити мене додати нову секцію, змінити стилі або налаштувати сайт."
        : "Hello! I am your AI Developer Agent. Ask me to add new sections, change styles, or adjust your website.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  // Code & Files state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string>("website.config.json");
  const [fileContent, setFileContent] = useState<string>("");

  // History & Checkpoints state
  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);

  // Push new state to undo/redo history
  const pushDocumentChange = useCallback((newDoc: WebsiteDocument) => {
    setDoc(newDoc);
    setSaveStatus("unsaved");
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newDoc];
    });
    setHistoryIndex((prev) => prev + 1);
  }, [historyIndex]);

  const undo = () => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      if (prev) {
        setHistoryIndex(historyIndex - 1);
        setDoc(prev);
        setSaveStatus("unsaved");
      }
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      if (next) {
        setHistoryIndex(historyIndex + 1);
        setDoc(next);
        setSaveStatus("unsaved");
      }
    }
  };

  // Load project & website.config.json
  const loadProject = async () => {
    if (!companyId || !projectId) return;
    setLoading(true);
    try {
      // 1. Check if website.config.json exists
      try {
        const fileRes = await apiGet<{ content: string }>(`${base}/files/read?path=website.config.json`);
        const parsed = JSON.parse(fileRes.content) as WebsiteDocument;
        setDoc(parsed);
        if (parsed.pages[0]) setActivePageId(parsed.pages[0].id);
        setHistory([parsed]);
        setHistoryIndex(0);
      } catch {
        // If not found, create default document from project metadata
        const proj = await apiGet<any>(base);
        const newDoc = createDefaultWebsiteDocument(
          proj.name || "My Website",
          proj.framework?.toLowerCase().includes("vite") ? "vite" : "nextjs",
          { purpose: proj.description }
        );
        setDoc(newDoc);
        if (newDoc.pages[0]) setActivePageId(newDoc.pages[0].id);
        setHistory([newDoc]);
        setHistoryIndex(0);
        // Persist initial scaffold
        await saveDocumentToProject(newDoc);
      }

      // 2. Load preview status
      await refreshPreview();

      // 3. Load files
      await loadFiles();
    } catch (err: any) {
      setError(err.message || "Failed to load website");
    } finally {
      setLoading(false);
    }
  };

  const refreshPreview = async () => {
    try {
      const status = await apiGet<PreviewStatusResponse>(`${base}/preview/status`);
      setPreviewStatus(status);
    } catch {
      // preview might not be configured
    }
  };

  const loadFiles = async () => {
    try {
      const res = await apiGet<{ files: FileEntry[] }>(`${base}/files/tree`);
      setFiles(res.files || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadProject();
  }, [companyId, projectId]);

  // Save document to project workspace
  const saveDocumentToProject = async (documentToSave?: WebsiteDocument) => {
    const targetDoc = documentToSave || doc;
    if (!targetDoc) return;
    setSaveStatus("saving");
    try {
      const adapter = getWebsiteAdapter(targetDoc.framework);
      const synced = adapter.syncDocument(targetDoc);

      // Write website.config.json
      await apiPost(`${base}/files/write`, {
        path: "website.config.json",
        content: JSON.stringify(targetDoc, null, 2) + "\n",
      });

      // Write synced globals.css & page files
      for (const [filePath, content] of Object.entries(synced)) {
        if (filePath !== "website.config.json") {
          try {
            await apiPost(`${base}/files/write`, { path: filePath, content });
          } catch {}
        }
      }

      setSaveStatus("saved");
      setIframeKey((k) => k + 1);
    } catch (err: any) {
      setSaveStatus("unsaved");
      alert(err.message || "Failed to save website");
    }
  };

  // Preview controls
  const handleStartPreview = async () => {
    setPreviewLoading(true);
    try {
      await apiPost(`${base}/preview/start`);
      await refreshPreview();
      setIframeKey((k) => k + 1);
    } catch (err: any) {
      alert(err.message || "Failed to start preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStopPreview = async () => {
    setPreviewLoading(true);
    try {
      await apiPost(`${base}/preview/stop`);
      await refreshPreview();
    } catch (err: any) {
      alert(err.message || "Failed to stop preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  // Active page & blocks
  const activePage = useMemo(() => {
    if (!doc) return null;
    return doc.pages.find((p) => p.id === activePageId) || doc.pages[0] || null;
  }, [doc, activePageId]);

  const selectedBlock = useMemo(() => {
    if (!activePage || !selectedBlockId) return null;
    return activePage.blocks.find((b) => b.id === selectedBlockId) || null;
  }, [activePage, selectedBlockId]);

  // Block manipulation
  const handleAddBlock = (type: WebsiteBlockType) => {
    if (!doc || !activePage) return;
    const def = COMPONENT_REGISTRY[type];
    const newBlock: WebsiteBlock = {
      id: `block-${type}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      name: def.title,
      props: JSON.parse(JSON.stringify(def.defaultProps)),
      styles: JSON.parse(JSON.stringify(def.defaultStyles)),
    };

    const updatedPages = doc.pages.map((p) => {
      if (p.id !== activePage.id) return p;
      return {
        ...p,
        blocks: [...p.blocks, newBlock],
      };
    });

    const newDoc: WebsiteDocument = {
      ...doc,
      pages: updatedPages,
      updatedAt: new Date().toISOString(),
    };

    pushDocumentChange(newDoc);
    setSelectedBlockId(newBlock.id);
  };

  const handleMoveBlock = (blockId: string, direction: "up" | "down") => {
    if (!doc || !activePage) return;
    const blocks = [...activePage.blocks];
    const index = blocks.findIndex((b) => b.id === blockId);
    if (index === -1) return;
    if (direction === "up" && index > 0) {
      const item = blocks[index];
      if (item) {
        blocks.splice(index, 1);
        blocks.splice(index - 1, 0, item);
      }
    } else if (direction === "down" && index < blocks.length - 1) {
      const item = blocks[index];
      if (item) {
        blocks.splice(index, 1);
        blocks.splice(index + 1, 0, item);
      }
    }

    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
  };

  const handleDuplicateBlock = (blockId: string) => {
    if (!doc || !activePage) return;
    const blocks = [...activePage.blocks];
    const index = blocks.findIndex((b) => b.id === blockId);
    if (index === -1) return;
    const original = blocks[index];
    if (!original) return;
    const clone: WebsiteBlock = {
      ...JSON.parse(JSON.stringify(original)),
      id: `block-${original.type}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${original.name || original.type} (Copy)`,
    };
    blocks.splice(index + 1, 0, clone);

    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
    setSelectedBlockId(clone.id);
  };

  const handleDeleteBlock = (blockId: string) => {
    if (!doc || !activePage) return;
    const blocks = activePage.blocks.filter((b) => b.id !== blockId);
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  };

  const handleToggleHideBlock = (blockId: string) => {
    if (!doc || !activePage) return;
    const blocks = activePage.blocks.map((b) => (b.id === blockId ? { ...b, isHidden: !b.isHidden } : b));
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
  };

  const handleUpdateBlockProp = (key: string, value: any) => {
    if (!doc || !activePage || !selectedBlock) return;
    const blocks = activePage.blocks.map((b) => {
      if (b.id !== selectedBlock.id) return b;
      return {
        ...b,
        props: { ...b.props, [key]: value },
      };
    });
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
  };

  const handleUpdateBlockStyle = (styleKey: keyof BlockStyles, value: any) => {
    if (!doc || !activePage || !selectedBlock) return;
    const blocks = activePage.blocks.map((b) => {
      if (b.id !== selectedBlock.id) return b;
      return {
        ...b,
        styles: { ...(b.styles || {}), [styleKey]: value },
      };
    });
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
  };

  // Page management
  const handleAddPage = async () => {
    if (!doc) return;
    const title = await promptModal({ message: language === "uk" ? "Назва нової сторінки:" : "New page title:" });
    if (!title || !title.trim()) return;
    const slug = "/" + title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const newPage: WebsitePage = {
      id: `page-${Math.random().toString(36).slice(2, 7)}`,
      title: title.trim(),
      slug,
      blocks: [
        {
          id: `block-navbar-${Math.random().toString(36).slice(2, 7)}`,
          type: "navbar",
          name: "Navigation",
          props: { ...COMPONENT_REGISTRY.navbar.defaultProps, brandName: doc.name },
          styles: { ...COMPONENT_REGISTRY.navbar.defaultStyles },
        },
        {
          id: `block-hero-${Math.random().toString(36).slice(2, 7)}`,
          type: "hero",
          name: title.trim(),
          props: { ...COMPONENT_REGISTRY.hero.defaultProps, title: title.trim() },
          styles: { ...COMPONENT_REGISTRY.hero.defaultStyles },
        },
        {
          id: `block-footer-${Math.random().toString(36).slice(2, 7)}`,
          type: "footer",
          name: "Footer",
          props: { ...COMPONENT_REGISTRY.footer.defaultProps, brandName: doc.name },
          styles: { ...COMPONENT_REGISTRY.footer.defaultStyles },
        },
      ],
    };

    const newDoc: WebsiteDocument = {
      ...doc,
      pages: [...doc.pages, newPage],
      updatedAt: new Date().toISOString(),
    };
    pushDocumentChange(newDoc);
    setActivePageId(newPage.id);
  };

  const handleDeletePage = async (pageId: string) => {
    if (!doc) return;
    if (doc.pages.length <= 1) {
      alert("Cannot delete the only page of the website.");
      return;
    }
    if (!(await confirmModal({ message: language === "uk" ? "Видалити цю сторінку?" : "Delete this page?", isDanger: true }))) return;
    const updatedPages = doc.pages.filter((p) => p.id !== pageId);
    const newDoc: WebsiteDocument = { ...doc, pages: updatedPages, updatedAt: new Date().toISOString() };
    pushDocumentChange(newDoc);
    if (activePageId === pageId && updatedPages[0]) setActivePageId(updatedPages[0].id);
  };

  // Asset upload
  const handleUploadAsset = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAsset(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result as string;
          const uploaded = await apiPost<{ path: string; url: string; name: string }>(
            `${base}/files/upload`,
            { name: file.name, base64Data }
          );

          if (selectedBlock) {
            // Automatically insert into active block image if applicable
            handleUpdateBlockProp("imageUrl", uploaded.url);
          }

          alert(language === "uk" ? `Файл ${uploaded.name} завантажено!` : `File ${uploaded.name} uploaded!`);
          await loadFiles();
        } catch (err: any) {
          alert(err.message || "Failed to upload asset");
        } finally {
          setUploadingAsset(false);
        }
      };
      reader.readAsDataURL(file);
    } catch {
      setUploadingAsset(false);
    }
  };

  // AI Chat
  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatBusy) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: userMsg }]);
    setChatBusy(true);

    try {
      const res = await apiPost<any>(`${base}/runs`, {
        task: userMsg,
      });

      setChatMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: res.message || res.result || (language === "uk" ? "Зміни застосовано до проєкту!" : "Changes applied to project!"),
        },
      ]);

      // Reload config & preview
      await loadProject();
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "assistant", content: `⚠️ ${err.message || "AI Task failed"}` },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  // Checkpoints
  const handleCreateCheckpoint = async () => {
    const name = await promptModal({ message: language === "uk" ? "Назва контрольної точки:" : "Checkpoint name:" });
    if (!name || !name.trim()) return;
    try {
      await apiPost(`${base}/checkpoints`, { name: name.trim() });
      const res = await apiGet<{ checkpoints: CheckpointItem[] }>(`${base}/checkpoints`);
      setCheckpoints(res.checkpoints || []);
      alert(language === "uk" ? "Точку збережено!" : "Checkpoint saved!");
    } catch (err: any) {
      alert(err.message || "Failed to create checkpoint");
    }
  };

  // Deploy
  const handleDeploy = async () => {
    setIsDeploying(true);
    try {
      await apiPost(`${base}/deploy`, { environment: "production", provider: "vercel" });
      alert(language === "uk" ? "Деплой запущено!" : "Deployment triggered!");
    } catch (err: any) {
      alert(err.message || "Deploy failed");
    } finally {
      setIsDeploying(false);
    }
  };

  // Device styles for preview iframe
  const deviceWidth = deviceMode === "mobile" ? "375px" : deviceMode === "tablet" ? "768px" : "100%";

  if (loading) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--muted-color, #8b949e)" }}>
        <p>Loading Website Editor...</p>
      </div>
    );
  }

  return (
    <div
      className="website-editor-root"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 60px)",
        background: "var(--background-color, #090d16)",
        color: "var(--text-color, #f0f6fc)",
        overflow: "hidden",
      }}
    >
      {/* Top Application Bar */}
      <header
        style={{
          height: "56px",
          borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.1))",
          background: "var(--surface-color, #0f141c)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 1rem",
          gap: "1rem",
          zIndex: 40,
        }}
      >
        {/* Left: Back & Project Title */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Link
            to="/settings/websites"
            className="button-secondary"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.85rem", textDecoration: "none" }}
            title="Back to Websites Dashboard"
          >
            ← Websites
          </Link>
          <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{doc?.name || "Website"}</span>
          <span className="status-pill status-ready" style={{ fontSize: "0.75rem" }}>
            {doc?.framework === "vite" ? "Vite" : "Next.js"}
          </span>
          <span
            style={{
              fontSize: "0.78rem",
              color: saveStatus === "saved" ? "#10b981" : saveStatus === "saving" ? "#f59e0b" : "#94a3b8",
            }}
          >
            {saveStatus === "saved" ? "● Saved" : saveStatus === "saving" ? "Saving..." : "○ Unsaved"}
          </span>
        </div>

        {/* Center: Device Mode Switcher */}
        <div style={{ display: "flex", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "2px" }}>
          <button
            type="button"
            className={`btn-device ${deviceMode === "desktop" ? "active" : ""}`}
            onClick={() => setDeviceMode("desktop")}
            style={{
              background: deviceMode === "desktop" ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              color: "inherit",
              padding: "0.35rem 0.75rem",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            💻 Desktop
          </button>
          <button
            type="button"
            className={`btn-device ${deviceMode === "tablet" ? "active" : ""}`}
            onClick={() => setDeviceMode("tablet")}
            style={{
              background: deviceMode === "tablet" ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              color: "inherit",
              padding: "0.35rem 0.75rem",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            📱 Tablet
          </button>
          <button
            type="button"
            className={`btn-device ${deviceMode === "mobile" ? "active" : ""}`}
            onClick={() => setDeviceMode("mobile")}
            style={{
              background: deviceMode === "mobile" ? "rgba(255,255,255,0.15)" : "transparent",
              border: "none",
              color: "inherit",
              padding: "0.35rem 0.75rem",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            📱 Mobile
          </button>
        </div>

        {/* Right: Actions (Undo/Redo, Save, Preview, Deploy) */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            className="button-secondary"
            onClick={undo}
            disabled={historyIndex <= 0}
            title="Undo"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.85rem" }}
          >
            ↩
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            title="Redo"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.85rem" }}
          >
            ↪
          </button>

          <button
            type="button"
            className="button-secondary"
            onClick={() => void saveDocumentToProject()}
            disabled={saveStatus === "saving"}
            style={{ padding: "0.35rem 0.85rem", fontSize: "0.85rem" }}
          >
            💾 Save
          </button>

          {previewStatus?.isRunning ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void handleStopPreview()}
              disabled={previewLoading}
              style={{ padding: "0.35rem 0.75rem", fontSize: "0.85rem" }}
            >
              ⏹ Stop
            </button>
          ) : (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void handleStartPreview()}
              disabled={previewLoading}
              style={{ padding: "0.35rem 0.75rem", fontSize: "0.85rem" }}
            >
              ▶ Preview
            </button>
          )}

          {previewStatus?.previewUrl && (
            <a
              href={previewStatus.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="button-secondary"
              style={{ padding: "0.35rem 0.75rem", fontSize: "0.85rem", textDecoration: "none" }}
            >
              ↗ Open
            </a>
          )}

          <button
            type="button"
            className="button-primary"
            onClick={() => void handleDeploy()}
            disabled={isDeploying}
            style={{ padding: "0.35rem 0.95rem", fontSize: "0.85rem" }}
          >
            🚀 Deploy
          </button>
        </div>
      </header>

      {/* Main 3-Column Workspace */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left Navigation Bar (Tab icons) */}
        <aside
          style={{
            width: "60px",
            borderRight: "1px solid var(--border-color, rgba(255,255,255,0.1))",
            background: "var(--surface-color, #0f141c)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "0.75rem 0",
            gap: "0.5rem",
          }}
        >
          <button
            type="button"
            className={`tab-btn ${activeTab === "blocks" ? "active" : ""}`}
            onClick={() => setActiveTab("blocks")}
            title="Blocks & Components"
            style={{
              background: activeTab === "blocks" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "blocks" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🧱
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "pages" ? "active" : ""}`}
            onClick={() => setActiveTab("pages")}
            title="Pages"
            style={{
              background: activeTab === "pages" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "pages" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            📑
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "theme" ? "active" : ""}`}
            onClick={() => setActiveTab("theme")}
            title="Styles & Colors"
            style={{
              background: activeTab === "theme" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "theme" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🎨
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "assets" ? "active" : ""}`}
            onClick={() => setActiveTab("assets")}
            title="Assets & Media"
            style={{
              background: activeTab === "assets" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "assets" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🖼️
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
            title="AI Chat Assistant"
            style={{
              background: activeTab === "chat" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "chat" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🤖
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "code" ? "active" : ""}`}
            onClick={() => setActiveTab("code")}
            title="Code & Files"
            style={{
              background: activeTab === "code" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "code" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            📁
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "seo" ? "active" : ""}`}
            onClick={() => setActiveTab("seo")}
            title="SEO Settings"
            style={{
              background: activeTab === "seo" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "seo" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🔍
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
            title="History & Checkpoints"
            style={{
              background: activeTab === "history" ? "rgba(59, 130, 246, 0.2)" : "transparent",
              color: activeTab === "history" ? "#60a5fa" : "inherit",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem",
              fontSize: "1.2rem",
              cursor: "pointer",
            }}
          >
            🕒
          </button>
        </aside>

        {/* Left Side Panel (Content depending on activeTab) */}
        <aside
          style={{
            width: "300px",
            borderRight: "1px solid var(--border-color, rgba(255,255,255,0.1))",
            background: "var(--surface-color, #0f141c)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* TAB 1: BLOCKS / OUTLINE */}
          {activeTab === "blocks" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Blocks Outline</h3>
                <span style={{ fontSize: "0.8rem", color: "var(--muted-color, #8b949e)" }}>
                  {activePage?.blocks.length || 0} blocks
                </span>
              </div>

              {/* Add Block Dropdown */}
              <div style={{ marginBottom: "1rem" }}>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      handleAddBlock(e.target.value as WebsiteBlockType);
                      e.target.value = "";
                    }
                  }}
                  style={{
                    width: "100%",
                    padding: "0.55rem",
                    borderRadius: "6px",
                    background: "rgba(59, 130, 246, 0.15)",
                    color: "#60a5fa",
                    border: "1px solid rgba(59, 130, 246, 0.3)",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <option value="" disabled>+ Add Section / Block...</option>
                  {Object.entries(COMPONENT_REGISTRY).map(([type, def]) => (
                    <option key={type} value={type}>
                      {def.icon} {def.title}
                    </option>
                  ))}
                </select>
              </div>

              {/* Block List with reordering */}
              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {(activePage?.blocks || []).map((b, idx) => {
                  const isSelected = selectedBlockId === b.id;
                  const def = COMPONENT_REGISTRY[b.type] || COMPONENT_REGISTRY.custom;

                  return (
                    <div
                      key={b.id}
                      onClick={() => setSelectedBlockId(b.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.55rem 0.75rem",
                        borderRadius: "6px",
                        background: isSelected ? "rgba(59, 130, 246, 0.2)" : "rgba(255,255,255,0.03)",
                        border: isSelected ? "1px solid #3b82f6" : "1px solid rgba(255,255,255,0.06)",
                        cursor: "pointer",
                        opacity: b.isHidden ? 0.5 : 1,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", overflow: "hidden" }}>
                        <span>{def.icon}</span>
                        <span style={{ fontSize: "0.85rem", fontWeight: isSelected ? 600 : 400, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                          {b.name || def.title}
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleMoveBlock(b.id, "up"); }}
                          disabled={idx === 0}
                          style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "2px" }}
                          title="Move Up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleMoveBlock(b.id, "down"); }}
                          disabled={idx === (activePage?.blocks.length || 0) - 1}
                          style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "2px" }}
                          title="Move Down"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleToggleHideBlock(b.id); }}
                          style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "2px" }}
                          title={b.isHidden ? "Show" : "Hide"}
                        >
                          {b.isHidden ? "👁️‍🗨️" : "👁️"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleDuplicateBlock(b.id); }}
                          style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "2px" }}
                          title="Duplicate"
                        >
                          📋
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleDeleteBlock(b.id); }}
                          style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", padding: "2px" }}
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: PAGES */}
          {activeTab === "pages" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Pages</h3>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => void handleAddPage()}
                  style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                >
                  + Add Page
                </button>
              </div>

              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {(doc?.pages || []).map((page) => {
                  const isActive = page.id === activePageId;
                  return (
                    <div
                      key={page.id}
                      onClick={() => setActivePageId(page.id)}
                      style={{
                        padding: "0.75rem",
                        borderRadius: "8px",
                        background: isActive ? "rgba(59, 130, 246, 0.2)" : "rgba(255,255,255,0.03)",
                        border: isActive ? "1px solid #3b82f6" : "1px solid rgba(255,255,255,0.06)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{page.title}</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--muted-color, #8b949e)" }}>{page.slug}</div>
                      </div>

                      {page.slug !== "/" && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void handleDeletePage(page.id); }}
                          style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer" }}
                          title="Delete Page"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: THEME & GLOBAL STYLES */}
          {activeTab === "theme" && doc && (
            <div style={{ padding: "1rem", overflowY: "auto" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "1rem" }}>Global Theme & Colors</h3>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Primary Brand Color</label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="color"
                    value={doc.theme.primaryColor}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, primaryColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                    style={{ border: "none", width: "36px", height: "36px", borderRadius: "6px", cursor: "pointer" }}
                  />
                  <input
                    type="text"
                    value={doc.theme.primaryColor}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, primaryColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                    style={{ flex: 1, padding: "0.4rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Background Color</label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="color"
                    value={doc.theme.backgroundColor}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, backgroundColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                    style={{ border: "none", width: "36px", height: "36px", borderRadius: "6px", cursor: "pointer" }}
                  />
                  <input
                    type="text"
                    value={doc.theme.backgroundColor}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, backgroundColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                    style={{ flex: 1, padding: "0.4rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Font Family</label>
                <select
                  value={doc.theme.fontFamily}
                  onChange={(e) => {
                    pushDocumentChange({
                      ...doc,
                      theme: { ...doc.theme, fontFamily: e.target.value as any },
                      updatedAt: new Date().toISOString(),
                    });
                  }}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                >
                  <option value="system">System Default</option>
                  <option value="inter">Inter (Modern Sans)</option>
                  <option value="roboto">Roboto</option>
                  <option value="geist">Geist</option>
                  <option value="playfair">Playfair Display (Editorial)</option>
                </select>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Border Radius</label>
                <select
                  value={doc.theme.borderRadius}
                  onChange={(e) => {
                    pushDocumentChange({
                      ...doc,
                      theme: { ...doc.theme, borderRadius: e.target.value as any },
                      updatedAt: new Date().toISOString(),
                    });
                  }}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                >
                  <option value="none">Square (0px)</option>
                  <option value="sm">Small (6px)</option>
                  <option value="md">Medium (10px)</option>
                  <option value="lg">Large (16px)</option>
                  <option value="full">Rounded (Pill)</option>
                </select>
              </div>
            </div>
          )}

          {/* TAB 4: ASSETS & MEDIA */}
          {activeTab === "assets" && (
            <div style={{ padding: "1rem", overflowY: "auto", display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ marginBottom: "1rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.5rem" }}>Media & Assets</h3>
                <label
                  className="button-primary"
                  style={{ display: "block", textAlign: "center", cursor: "pointer", padding: "0.5rem" }}
                >
                  {uploadingAsset ? "Uploading..." : "+ Upload Image"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => void handleUploadAsset(e)}
                    style={{ display: "none" }}
                    disabled={uploadingAsset}
                  />
                </label>
              </div>

              <div style={{ flex: 1, overflowY: "auto" }}>
                <p style={{ fontSize: "0.8rem", color: "var(--muted-color, #8b949e)", marginBottom: "0.75rem" }}>
                  Uploaded assets are stored in <code>public/assets</code>. Click on any image URL to copy or insert.
                </p>

                {files.filter((f) => f.path.match(/\.(png|jpg|jpeg|svg|webp|gif)$/i)).length === 0 ? (
                  <p style={{ fontSize: "0.85rem", fontStyle: "italic", color: "var(--muted-color, #8b949e)" }}>
                    No media files uploaded yet.
                  </p>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    {files
                      .filter((f) => f.path.match(/\.(png|jpg|jpeg|svg|webp|gif)$/i))
                      .map((f) => {
                        const url = `/${f.path.replace(/^public\//, "")}`;
                        return (
                          <div
                            key={f.path}
                            onClick={() => {
                              if (selectedBlock) handleUpdateBlockProp("imageUrl", url);
                              navigator.clipboard.writeText(url);
                              alert(`Copied URL: ${url}`);
                            }}
                            style={{
                              border: "1px solid rgba(255,255,255,0.1)",
                              borderRadius: "6px",
                              padding: "4px",
                              cursor: "pointer",
                              textAlign: "center",
                            }}
                          >
                            <img src={url} alt={f.name} style={{ width: "100%", height: "70px", objectFit: "cover", borderRadius: "4px" }} />
                            <small style={{ fontSize: "0.7rem", display: "block", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                              {f.name}
                            </small>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: AI CHAT */}
          {activeTab === "chat" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(255,255,255,0.08)", fontWeight: 700 }}>
                🤖 AI Developer Agent
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      background: msg.role === "user" ? "var(--primary-color, #3b82f6)" : "rgba(255,255,255,0.06)",
                      color: "#fff",
                      borderRadius: "10px",
                      padding: "0.6rem 0.85rem",
                      maxWidth: "85%",
                      fontSize: "0.85rem",
                      lineHeight: 1.4,
                    }}
                  >
                    {msg.content}
                  </div>
                ))}
              </div>

              <form onSubmit={(e) => void handleSendChat(e)} style={{ padding: "0.75rem", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <input
                  type="text"
                  placeholder="Ask AI to modify site..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatBusy}
                  style={{
                    width: "100%",
                    padding: "0.55rem 0.75rem",
                    borderRadius: "6px",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#fff",
                    fontSize: "0.85rem",
                  }}
                />
              </form>
            </div>
          )}

          {/* TAB 6: CODE & FILES */}
          {activeTab === "code" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "1rem" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem" }}>Project Files</h3>
              <div style={{ flex: 1, overflowY: "auto" }}>
                {files.map((f) => (
                  <div
                    key={f.path}
                    onClick={async () => {
                      setSelectedFilePath(f.path);
                      try {
                        const content = await apiGet<{ content: string }>(`${base}/files/read?path=${encodeURIComponent(f.path)}`);
                        setFileContent(content.content);
                      } catch {}
                    }}
                    style={{
                      padding: "0.35rem 0.5rem",
                      fontSize: "0.8rem",
                      borderRadius: "4px",
                      cursor: "pointer",
                      background: selectedFilePath === f.path ? "rgba(59, 130, 246, 0.2)" : "transparent",
                    }}
                  >
                    {f.type === "directory" ? "📁" : "📄"} {f.path}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 7: SEO */}
          {activeTab === "seo" && activePage && doc && (
            <div style={{ padding: "1rem", overflowY: "auto" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "1rem" }}>Page SEO Settings</h3>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Page Title</label>
                <input
                  type="text"
                  value={activePage.seo?.title || ""}
                  onChange={(e) => {
                    const updatedPages = doc.pages.map((p) =>
                      p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), title: e.target.value } } : p
                    );
                    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
                  }}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Meta Description</label>
                <textarea
                  rows={3}
                  value={activePage.seo?.description || ""}
                  onChange={(e) => {
                    const updatedPages = doc.pages.map((p) =>
                      p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), description: e.target.value } } : p
                    );
                    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
                  }}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                />
              </div>
            </div>
          )}

          {/* TAB 8: HISTORY & CHECKPOINTS */}
          {activeTab === "history" && (
            <div style={{ padding: "1rem", overflowY: "auto", display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Checkpoints</h3>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => void handleCreateCheckpoint()}
                  style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }}
                >
                  + Save Point
                </button>
              </div>

              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {checkpoints.length === 0 ? (
                  <p style={{ fontSize: "0.85rem", color: "var(--muted-color, #8b949e)" }}>No checkpoints yet.</p>
                ) : (
                  checkpoints.map((cp) => (
                    <div
                      key={cp.id}
                      style={{
                        padding: "0.6rem",
                        borderRadius: "6px",
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{cp.name}</div>
                      <small style={{ color: "var(--muted-color, #8b949e)", fontSize: "0.75rem" }}>
                        {new Date(cp.createdAt).toLocaleTimeString()} · {cp.fileCount} files
                      </small>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>

        {/* Center Live Canvas / IFrame Viewport */}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            background: "#05080f",
            position: "relative",
            overflow: "hidden",
            padding: "1rem",
          }}
        >
          {previewStatus?.isRunning && previewStatus?.previewUrl ? (
            <div
              style={{
                width: deviceWidth,
                height: "100%",
                background: "#000",
                borderRadius: deviceMode === "desktop" ? "0" : "12px",
                overflow: "hidden",
                boxShadow: deviceMode === "desktop" ? "none" : "0 20px 40px rgba(0,0,0,0.8)",
                transition: "width 0.3s ease",
                border: deviceMode === "desktop" ? "none" : "2px solid rgba(255,255,255,0.15)",
              }}
            >
              <iframe
                key={iframeKey}
                src={previewStatus.previewUrl}
                title="Website Live Preview"
                style={{ width: "100%", height: "100%", border: "none" }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                textAlign: "center",
                padding: "2rem",
              }}
            >
              <span style={{ fontSize: "3rem", marginBottom: "1rem" }}>🌐</span>
              <h3 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.5rem" }}>Live Preview is Stopped</h3>
              <p style={{ color: "var(--muted-color, #8b949e)", maxWidth: "400px", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
                Start the sandbox dev server to preview your Next.js application live as you make visual changes.
              </p>
              <button
                type="button"
                className="button-primary"
                onClick={() => void handleStartPreview()}
                disabled={previewLoading}
                style={{ padding: "0.6rem 1.25rem", fontSize: "0.95rem" }}
              >
                {previewLoading ? "Starting Sandbox..." : "▶ Start Live Preview"}
              </button>
            </div>
          )}
        </main>

        {/* Right Properties Inspector Panel (shown when a block is selected) */}
        {selectedBlock && (
          <aside
            style={{
              width: "320px",
              borderLeft: "1px solid var(--border-color, rgba(255,255,255,0.1))",
              background: "var(--surface-color, #0f141c)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 1rem", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                  {COMPONENT_REGISTRY[selectedBlock.type]?.icon || "🧱"} {selectedBlock.name || selectedBlock.type}
                </span>
                <small style={{ display: "block", color: "var(--muted-color, #8b949e)", fontSize: "0.75rem" }}>
                  Properties Inspector
                </small>
              </div>
              <button
                type="button"
                onClick={() => setSelectedBlockId(null)}
                style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: "1.2rem" }}
              >
                ×
              </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
              {/* Dynamic Property Inputs based on COMPONENT_REGISTRY */}
              {(COMPONENT_REGISTRY[selectedBlock.type]?.propertySchema || []).map((field) => {
                const val = selectedBlock.props[field.key] ?? field.defaultValue ?? "";

                if (field.type === "string" || field.type === "link" || field.type === "image") {
                  return (
                    <div key={field.key} style={{ marginBottom: "1rem" }}>
                      <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                        {field.label}
                      </label>
                      <input
                        type="text"
                        value={val}
                        onChange={(e) => handleUpdateBlockProp(field.key, e.target.value)}
                        style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                      />
                    </div>
                  );
                }

                if (field.type === "textarea") {
                  return (
                    <div key={field.key} style={{ marginBottom: "1rem" }}>
                      <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                        {field.label}
                      </label>
                      <textarea
                        rows={3}
                        value={val}
                        onChange={(e) => handleUpdateBlockProp(field.key, e.target.value)}
                        style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                      />
                    </div>
                  );
                }

                if (field.type === "boolean") {
                  return (
                    <div key={field.key} style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(val)}
                        onChange={(e) => handleUpdateBlockProp(field.key, e.target.checked)}
                      />
                      <label style={{ fontSize: "0.85rem" }}>{field.label}</label>
                    </div>
                  );
                }

                if (field.type === "select") {
                  return (
                    <div key={field.key} style={{ marginBottom: "1rem" }}>
                      <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                        {field.label}
                      </label>
                      <select
                        value={val}
                        onChange={(e) => handleUpdateBlockProp(field.key, e.target.value)}
                        style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                      >
                        {(field.options || []).map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }

                return null;
              })}

              {/* Block Style Controls */}
              <div style={{ marginTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "1rem" }}>
                <h4 style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted-color, #8b949e)" }}>
                  Style & Layout
                </h4>

                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Text Alignment</label>
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    {(["left", "center", "right"] as const).map((align) => (
                      <button
                        key={align}
                        type="button"
                        className="button-secondary"
                        onClick={() => handleUpdateBlockStyle("textAlign", align)}
                        style={{
                          flex: 1,
                          padding: "0.35rem",
                          background: selectedBlock.styles?.textAlign === align ? "rgba(59, 130, 246, 0.25)" : undefined,
                          borderColor: selectedBlock.styles?.textAlign === align ? "#3b82f6" : undefined,
                          fontSize: "0.8rem",
                        }}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Padding Vertical</label>
                  <select
                    value={selectedBlock.styles?.paddingY || "medium"}
                    onChange={(e) => handleUpdateBlockStyle("paddingY", e.target.value)}
                    style={{ width: "100%", padding: "0.45rem", borderRadius: "6px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }}
                  >
                    <option value="none">None</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                    <option value="xlarge">Extra Large</option>
                  </select>
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.3rem" }}>Background Color</label>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <input
                      type="color"
                      value={selectedBlock.styles?.backgroundColor || "#090d16"}
                      onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                      style={{ border: "none", width: "32px", height: "32px", borderRadius: "6px", cursor: "pointer" }}
                    />
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => handleUpdateBlockStyle("backgroundColor", "transparent")}
                      style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                    >
                      Clear / Transparent
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

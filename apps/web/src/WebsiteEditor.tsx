import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal, alertModal } from "./ConfirmDialog";
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
import { IconBack, IconSave, IconDesktop, IconTablet, IconMobile, IconUndo, IconRedo, IconEye, IconEyeOff, IconPublish, IconMore, IconPlus, IconGrip, IconCopy, IconTrash, IconChevronDown, IconLink, IconAlignLeft, IconAlignCenter, IconAlignRight, IconFile, IconSparkles, IconClose, IconArrowUp, IconArrowDown, IconEdit, PAGE_ICON_OPTIONS, RenderPageIcon, IconSectionSymbol } from "./website-editor-icons";
import { WebsiteEditorLeftPanel } from "./website-editor-left-panel";
import { WebsiteEditorDrawers } from "./website-editor-drawers";
import { WebsiteEditorCanvas } from "./website-editor-canvas";
import { WebsiteEditorInspector } from "./website-editor-inspector";
import { DeviceMode, LeftPanelTab, InspectorTab, InspectorSubTab, ActiveDrawer, PreviewStatusResponse, FileEntry, CheckpointItem, apiGet, apiPost, buildMockupDocument } from "./website-editor-support";
export * from "./website-editor-icons";
export * from "./website-editor-support";

// ---------------------------------------------------------------------------
// Main WebsiteEditor Component
// ---------------------------------------------------------------------------
export function WebsiteEditor() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

  // Core Document State
  const [doc, setDoc] = useState<WebsiteDocument | null>(null);
  const [staticHtml, setStaticHtml] = useState<string | null>(null);
  const [staticIndexHtml, setStaticIndexHtml] = useState<string | null>(null);
  const [staticIndexRevision, setStaticIndexRevision] = useState<string | null>(null);
  const [staticPagePath, setStaticPagePath] = useState("index.html");
  const [staticPreviewActive, setStaticPreviewActive] = useState(false);
  const [staticPreviewError, setStaticPreviewError] = useState("");
  const [visualConfigUnavailable, setVisualConfigUnavailable] = useState(false);
  const [activePageId, setActivePageId] = useState<string>("page-home");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>("block-hero");

  // History & Undo / Redo
  const [history, setHistory] = useState<WebsiteDocument[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // Layout & UI State
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [leftTab, setLeftTab] = useState<LeftPanelTab>("pages");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("properties");
  const [inspectorSubTab, setInspectorSubTab] = useState<InspectorSubTab>("content");
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving">("saved");
  const [loading, setLoading] = useState(true);

  // More menu & Drawers
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);

  // Popover menus & page modal
  const [openPageMenuId, setOpenPageMenuId] = useState<string | null>(null);
  const [openBlockMenuId, setOpenBlockMenuId] = useState<string | null>(null);
  const [inspectorBlockMenuOpen, setInspectorBlockMenuOpen] = useState(false);
  const [addSectionMenuOpen, setAddSectionMenuOpen] = useState(false);
  const [iconSearch, setIconSearch] = useState("");
  const [pageModal, setPageModal] = useState<{
    isOpen: boolean;
    mode: "add" | "edit";
    pageId?: string;
    title: string;
    slug: string;
    icon: string;
  }>({
    isOpen: false,
    mode: "add",
    title: "",
    slug: "",
    icon: "file",
  });

  // Preview Mode: visual DOM preview vs running Next.js sandbox iframe
  const [previewMode, setPreviewMode] = useState<"visual" | "sandbox">("visual");
  const [previewStatus, setPreviewStatus] = useState<PreviewStatusResponse | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  // Files & Checkpoints & AI
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string>("website.config.json");
  const [fileContent, setFileContent] = useState<string>("");
  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([
    {
      id: "initial-assistant",
      role: "assistant",
      content: language === "uk"
        ? "Привіт! Я ваш AI Developer Agent. Ви можете попросити мене додати новий блок, змінити тексти або оновити стилі."
        : "Hello! I am your AI Developer Agent. Ask me to add new sections, change copy, or adjust styling.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  // Close more menu on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

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

  // Static websites are rendered from the same HTML files that chat Preview opens.
  const loadStaticPage = async (filePath: string) => {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) {
      setStaticPreviewError("Invalid website page.");
      return;
    }
    setStaticHtml(null);
    setStaticPreviewError("");
    try {
      const page = await apiGet<{ content: string; revision: string }>(base + "/files/read?path=" + encodeURIComponent(filePath));
      setStaticPagePath(filePath);
      setStaticHtml(page.content);
      if (filePath === "index.html") {
        setStaticIndexHtml(page.content);
        setStaticIndexRevision(page.revision);
      }
    } catch (error) {
      setStaticPreviewError(error instanceof Error ? error.message : "Website page is unavailable.");
    }
  };

  const loadStaticPreview = async () => {
    setStaticPreviewActive(true);
    await loadStaticPage("index.html");
  };

  const handleStaticFrameLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    event.currentTarget.contentDocument?.addEventListener("click", (clickEvent) => {
      const target = clickEvent.target as Element | null;
      const link = typeof target?.closest === "function" ? target.closest("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const resolved = new URL(href, "https://npati-project.local/" + staticPagePath);
      if (resolved.origin !== "https://npati-project.local") return;
      const requested = resolved.pathname.replace(/^\/+|\/+$/g, "") || "index";
      const filePath = requested.endsWith(".html") ? requested : requested + ".html";
      if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.html$/i.test(filePath)) return;
      clickEvent.preventDefault();
      void loadStaticPage(filePath);
    });
  };
  // Load project & website config
  const loadProject = async () => {
    if (!companyId || !projectId) return;
    setLoading(true);
    setSaveStatus("saved");
    setStaticHtml(null);
    setStaticIndexHtml(null);
    setStaticIndexRevision(null);
    setStaticPreviewActive(false);
    setStaticPreviewError("");
    setVisualConfigUnavailable(false);
    setPreviewMode("visual");
    try {
      try {
        const fileRes = await apiGet<{ content: string }>(base + "/files/read?path=website.config.json");
        const parsed = JSON.parse(fileRes.content) as WebsiteDocument;
        if (!Array.isArray(parsed.pages)) throw new Error("Invalid website configuration");

        if (parsed.framework === "static") {
          setDoc(parsed);
          setActivePageId(parsed.pages[0]?.id || "page-home");
          setSelectedBlockId(parsed.pages[0]?.blocks[1]?.id || parsed.pages[0]?.blocks[0]?.id || null);
          setHistory([parsed]);
          setHistoryIndex(0);
          await loadStaticPreview();
        } else if (!parsed.pages[0]?.blocks?.length) {
          const mockupDoc = buildMockupDocument(parsed.name, parsed.framework === "vite" ? "vite" : "nextjs");
          setDoc(mockupDoc);
          setActivePageId(mockupDoc.pages[0]?.id || "page-home");
          setSelectedBlockId(mockupDoc.pages[0]?.blocks[1]?.id || "block-hero");
          setHistory([mockupDoc]);
          setHistoryIndex(0);
          setVisualConfigUnavailable(true);
        } else {
          setDoc(parsed);
          if (parsed.pages[0]) {
            setActivePageId(parsed.pages[0].id);
            setSelectedBlockId(parsed.pages[0].blocks[1]?.id || parsed.pages[0].blocks[0]?.id || null);
          }
          setHistory([parsed]);
          setHistoryIndex(0);
        }
      } catch {
        const proj = await apiGet<{ name?: string; framework?: string }>(base);
        if (/^(?:html\/css|static)$/i.test(proj.framework || "")) {
          const fallbackDoc = createDefaultWebsiteDocument(proj.name || "Website", "static", { template: "blank" });
          setDoc(fallbackDoc);
          setActivePageId(fallbackDoc.pages[0]?.id || "page-home");
          setSelectedBlockId(null);
          setHistory([fallbackDoc]);
          setHistoryIndex(0);
          await loadStaticPreview();
        } else {
          const mockupDoc = buildMockupDocument(
            proj.name || "My Business Website",
            proj.framework?.toLowerCase().includes("vite") ? "vite" : "nextjs"
          );
          setDoc(mockupDoc);
          setActivePageId(mockupDoc.pages[0]?.id || "page-home");
          setSelectedBlockId(mockupDoc.pages[0]?.blocks[1]?.id || "block-hero");
          setHistory([mockupDoc]);
          setHistoryIndex(0);
          setVisualConfigUnavailable(true);
        }
      }

      const status = await refreshPreview();
      if (status?.isRunning) setPreviewMode("sandbox");
      await loadFiles();
    } catch (err: any) {
      void alertModal({ title: "Load Error", message: err.message || "Failed to load website" });
    } finally {
      setLoading(false);
    }
  };
  const refreshPreview = async () => {
    try {
      const status = await apiGet<PreviewStatusResponse>(`${base}/preview/status`);
      setPreviewStatus(status);
      return status;
    } catch { return null; }
  };

  const loadFiles = async () => {
    try {
      const res = await apiGet<{ files: FileEntry[] }>(`${base}/files/tree`);
      setFiles(res.files || []);
    } catch {}
  };

  useEffect(() => {
    void loadProject();
  }, [companyId, projectId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(".npati-builder-action-popover") ||
        target?.closest(".npati-builder-more-btn") ||
        target?.closest(".npati-builder-page-settings-btn") ||
        target?.closest(".npati-builder-add-section-btn")
      ) {
        return;
      }
      setOpenPageMenuId(null);
      setOpenBlockMenuId(null);
      setInspectorBlockMenuOpen(false);
      setAddSectionMenuOpen(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  // Save document to backend
  const saveDocumentToProject = async (documentToSave?: WebsiteDocument) => {
    const targetDoc = documentToSave || doc;
    if (!targetDoc) return;
    const adapter = getWebsiteAdapter(targetDoc.framework);
    const synced = adapter.syncDocument(targetDoc);
    if (targetDoc.framework === "static" && staticIndexHtml && staticIndexHtml !== synced["index.html"]) {
      const confirmed = await confirmModal({
        title: language === "uk" ? "Замінити HTML сайту?" : "Replace the website HTML?",
        message: language === "uk"
          ? "Візуальний конструктор згенерує index.html із блоків конфігурації та замінить HTML, створений агентом. Продовжити?"
          : "The visual editor will generate index.html from its blocks and replace the HTML created by the agent. Continue?",
      });
      if (!confirmed) return;
    }
    setSaveStatus("saving");
    try {
      for (const [filePath, content] of Object.entries(synced)) {
        if (filePath === "website.config.json") continue;
        const saved = await apiPost<{ revision?: string }>(base + "/files/write", {
          path: filePath,
          content,
          ...(targetDoc.framework === "static" && filePath === "index.html" && staticIndexRevision
            ? { expectedRevision: staticIndexRevision }
            : {}),
        });
        if (targetDoc.framework === "static" && filePath === "index.html") {
          setStaticIndexRevision(saved.revision ?? null);
        }
      }
      await apiPost(base + "/files/write", {
        path: "website.config.json",
        content: JSON.stringify(targetDoc, null, 2) + "\n",
      });
      if (targetDoc.framework === "static") {
        setStaticHtml(synced["index.html"] ?? null);
        setStaticIndexHtml(synced["index.html"] ?? null);
        setStaticPagePath("index.html");
        setStaticPreviewError("");
        setStaticPreviewActive(true);
      }
      setSaveStatus("saved");
      setVisualConfigUnavailable(false);
      setIframeKey((k) => k + 1);
    } catch (err: any) {
      setSaveStatus("unsaved");
      void alertModal({ title: "Save Error", message: err.message || "Failed to save website" });
    }
  };

  // Preview sandbox handlers
  const handleStartPreview = async () => {
    try {
      await apiPost(`${base}/preview/start`);
      await refreshPreview();
      setPreviewMode("sandbox");
      setIframeKey((k) => k + 1);
    } catch (err: any) {
      void alertModal({ title: "Preview Error", message: err.message || "Failed to start preview" });
    }
  };

  // Active page & selected block
  const activePage = useMemo(() => {
    if (!doc) return null;
    return doc.pages.find((p) => p.id === activePageId) || doc.pages[0] || null;
  }, [doc, activePageId]);

  const selectedBlock = useMemo(() => {
    if (!activePage || !selectedBlockId) return null;
    return activePage.blocks.find((b) => b.id === selectedBlockId) || null;
  }, [activePage, selectedBlockId]);

  // Rename site
  const handleRenameSite = async () => {
    if (!doc) return;
    const next = await promptModal({
      title: language === "uk" ? "Перейменувати сайт" : "Rename Website",
      message: language === "uk" ? "Нова назва сайту:" : "New website name:",
      defaultValue: doc.name,
    });
    if (!next || !next.trim() || next.trim() === doc.name) return;
    pushDocumentChange({
      ...doc,
      name: next.trim(),
      updatedAt: new Date().toISOString(),
    });
  };

  // Add block
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
    setInspectorTab("properties");
  };

  // Reorder block
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

  // Duplicate block
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

  // Delete block
  const handleDeleteBlock = async (blockId: string) => {
    if (!doc || !activePage) return;
    const ok = await confirmModal({
      title: language === "uk" ? "Видалити блок?" : "Delete block?",
      message: language === "uk" ? "Цей блок буде видалено зі сторінки." : "This block will be removed from the page.",
      isDanger: true,
    });
    if (!ok) return;

    const blocks = activePage.blocks.filter((b) => b.id !== blockId);
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
    if (selectedBlockId === blockId) {
      setSelectedBlockId(blocks[0]?.id || null);
    }
  };

  // Toggle hide block
  const handleToggleHideBlock = (blockId: string) => {
    if (!doc || !activePage) return;
    const blocks = activePage.blocks.map((b) => (b.id === blockId ? { ...b, isHidden: !b.isHidden } : b));
    const updatedPages = doc.pages.map((p) => (p.id === activePage.id ? { ...p, blocks } : p));
    pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
  };

  // Update block prop
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

  // Update block style
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

  // Page Handlers
  const handleOpenAddPageModal = () => {
    setPageModal({
      isOpen: true,
      mode: "add",
      title: "",
      slug: "",
      icon: "file",
    });
  };

  const handleOpenEditPageModal = (page: WebsitePage) => {
    setPageModal({
      isOpen: true,
      mode: "edit",
      pageId: page.id,
      title: page.title,
      slug: page.slug,
      icon: page.icon || (page.slug === "/" ? "home" : "file"),
    });
  };

  const handleSavePageModal = () => {
    if (!doc || !pageModal.title.trim()) return;
    const cleanTitle = pageModal.title.trim();
    const cleanSlug = pageModal.slug.trim()
      ? (pageModal.slug.startsWith("/") ? pageModal.slug : "/" + pageModal.slug)
      : "/" + cleanTitle.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

    if (pageModal.mode === "add") {
      const newPage: WebsitePage = {
        id: `page-${Math.random().toString(36).slice(2, 7)}`,
        title: cleanTitle,
        slug: cleanSlug,
        icon: pageModal.icon,
        blocks: [
          {
            id: `block-navbar-${Math.random().toString(36).slice(2, 7)}`,
            type: "navbar",
            name: "Header",
            props: { ...COMPONENT_REGISTRY.navbar.defaultProps, brandName: doc.name },
            styles: { ...COMPONENT_REGISTRY.navbar.defaultStyles, backgroundColor: "#ffffff", textColor: "#0f172a" },
          },
          {
            id: `block-hero-${Math.random().toString(36).slice(2, 7)}`,
            type: "hero",
            name: "Hero Section",
            props: { ...COMPONENT_REGISTRY.hero.defaultProps, title: cleanTitle, badge: "New Page" },
            styles: { ...COMPONENT_REGISTRY.hero.defaultStyles, backgroundColor: "#F8FAFF", textColor: "#0f172a" },
          },
          {
            id: `block-footer-${Math.random().toString(36).slice(2, 7)}`,
            type: "footer",
            name: "Footer",
            props: { ...COMPONENT_REGISTRY.footer.defaultProps, brandName: doc.name },
            styles: { ...COMPONENT_REGISTRY.footer.defaultStyles, backgroundColor: "#ffffff" },
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
      setSelectedBlockId(newPage.blocks[1]?.id || newPage.blocks[0]?.id || null);
    } else if (pageModal.mode === "edit" && pageModal.pageId) {
      const updatedPages = doc.pages.map((p) =>
        p.id === pageModal.pageId
          ? { ...p, title: cleanTitle, slug: cleanSlug, icon: pageModal.icon }
          : p
      );
      const newDoc: WebsiteDocument = {
        ...doc,
        pages: updatedPages,
        updatedAt: new Date().toISOString(),
      };
      pushDocumentChange(newDoc);
    }

    setPageModal((prev) => ({ ...prev, isOpen: false }));
  };

  const handleDuplicatePage = (pageId: string) => {
    if (!doc) return;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    const clone: WebsitePage = {
      ...JSON.parse(JSON.stringify(page)),
      id: `page-${Math.random().toString(36).slice(2, 7)}`,
      title: `${page.title} (Copy)`,
      slug: `${page.slug}-copy`,
      blocks: page.blocks.map((b: any) => ({
        ...b,
        id: `block-${b.type}-${Math.random().toString(36).slice(2, 7)}`,
      })),
    };
    const newDoc: WebsiteDocument = {
      ...doc,
      pages: [...doc.pages, clone],
      updatedAt: new Date().toISOString(),
    };
    pushDocumentChange(newDoc);
    setActivePageId(clone.id);
  };

  const handleMovePage = (pageId: string, direction: "up" | "down") => {
    if (!doc) return;
    const pages = [...doc.pages];
    const index = pages.findIndex((p) => p.id === pageId);
    if (index === -1) return;
    if (direction === "up" && index > 0) {
      const item = pages[index];
      if (item) {
        pages.splice(index, 1);
        pages.splice(index - 1, 0, item);
      }
    } else if (direction === "down" && index < pages.length - 1) {
      const item = pages[index];
      if (item) {
        pages.splice(index, 1);
        pages.splice(index + 1, 0, item);
      }
    }
    const newDoc: WebsiteDocument = {
      ...doc,
      pages,
      updatedAt: new Date().toISOString(),
    };
    pushDocumentChange(newDoc);
  };

  // Delete page
  const handleDeletePage = async (pageId: string) => {
    if (!doc) return;
    if (doc.pages.length <= 1) {
      void alertModal({ message: "Cannot delete the only page of the website." });
      return;
    }
    const ok = await confirmModal({
      title: language === "uk" ? "Видалити сторінку?" : "Delete Page?",
      message: language === "uk" ? "Ви впевнені, що хочете видалити цю сторінку?" : "Are you sure you want to delete this page?",
      isDanger: true,
    });
    if (!ok) return;

    const updatedPages = doc.pages.filter((p) => p.id !== pageId);
    const newDoc: WebsiteDocument = { ...doc, pages: updatedPages, updatedAt: new Date().toISOString() };
    pushDocumentChange(newDoc);
    if (activePageId === pageId && updatedPages[0]) {
      setActivePageId(updatedPages[0].id);
      setSelectedBlockId(updatedPages[0].blocks[0]?.id || null);
    }
  };

  // Upload asset
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
            handleUpdateBlockProp("imageUrl", uploaded.url);
          }
          await loadFiles();
          void alertModal({ message: language === "uk" ? `Файл ${uploaded.name} завантажено!` : `File ${uploaded.name} uploaded!` });
        } catch (err: any) {
          void alertModal({ title: "Upload Failed", message: err.message || "Failed to upload asset" });
        } finally {
          setUploadingAsset(false);
        }
      };
      reader.readAsDataURL(file);
    } catch {
      setUploadingAsset(false);
    }
  };

  // Send AI Chat
  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatBusy) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: userMsg }]);
    setChatBusy(true);

    try {
      const res = await apiPost<any>(`${base}/runs`, { task: userMsg });
      setChatMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: res.message || res.result || (language === "uk" ? "Зміни застосовано до проєкту!" : "Changes applied to project!"),
        },
      ]);
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

  // Deploy to Production
  const handleDeploy = async () => {
    setIsDeploying(true);
    try {
      await apiPost(`${base}/deploy`, { environment: "production", provider: "vercel" });
      void alertModal({
        title: language === "uk" ? "Деплой розпочато" : "Deployment Started",
        message: language === "uk" ? "Сайт успішно опубліковано!" : "Website has been queued for production publish!",
      });
    } catch (err: any) {
      void alertModal({ title: "Deploy Failed", message: err.message || "Deployment failed" });
    } finally {
      setIsDeploying(false);
    }
  };

  // Device width for canvas preview
  const canvasWidth = deviceMode === "mobile" ? "375px" : deviceMode === "tablet" ? "768px" : "100%";

  if (loading) {
    return (
      <div className="npati-fullscreen-editor-shell" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "#64748b" }}>
          <div style={{ width: "36px", height: "36px", border: "3px solid #e2e8f0", borderTopColor: "#e11d2e", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px auto" }} />
          <p style={{ fontWeight: 600, fontSize: "14px", color: "#0f172a" }}>Loading Website Builder...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="npati-fullscreen-editor-shell npati-builder-root">
      {/* ========================================================================= */}
      {/* TOP APPLICATION BAR                                                       */}
      {/* ========================================================================= */}
      <header className="npati-builder-topbar">
        {/* Left: Back button, Website name, Framework badge, Saved status */}
        <div className="npati-builder-topbar-left">
          <Link to="/settings/websites" className="npati-builder-back-btn" title="Back to Websites">
            <IconBack />
          </Link>

          <div
            className="npati-builder-site-title"
            onClick={() => void handleRenameSite()}
            title="Click to rename website"
          >
            <span>{doc?.name || "My Business Website"}</span>
            <IconChevronDown />
          </div>

          <span className="npati-builder-framework-badge">
            <span style={{ fontSize: "10px", opacity: 0.7, marginRight: "2px" }}>{doc?.framework === "static" ? "HTM" : "NEX"}</span>
            {doc?.framework === "static" ? "HTML/CSS" : doc?.framework === "vite" ? "VITE" : "NEXT.JS"}
          </span>

          <div className={`npati-builder-save-status ${saveStatus}`}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: saveStatus === "saved" ? "#10b981" : saveStatus === "saving" ? "#f59e0b" : "#94a3b8",
              }}
            />
            <span>
              {saveStatus === "saved" ? "Saved 2 minutes ago" : saveStatus === "saving" ? "Saving..." : "Unsaved"}
            </span>
          </div>
        </div>

        {/* Center: Device Mode Switcher (Desktop / Tablet / Mobile) */}
        <div className="npati-builder-topbar-center">
          <div className="npati-builder-device-segmented">
            <button
              type="button"
              className={`npati-builder-device-btn ${deviceMode === "desktop" ? "active" : ""}`}
              onClick={() => setDeviceMode("desktop")}
              title="Desktop viewport"
            >
              <IconDesktop />
              <span>Desktop</span>
            </button>
            <button
              type="button"
              className={`npati-builder-device-btn ${deviceMode === "tablet" ? "active" : ""}`}
              onClick={() => setDeviceMode("tablet")}
              title="Tablet viewport"
            >
              <IconTablet />
              <span>Tablet</span>
            </button>
            <button
              type="button"
              className={`npati-builder-device-btn ${deviceMode === "mobile" ? "active" : ""}`}
              onClick={() => setDeviceMode("mobile")}
              title="Mobile viewport"
            >
              <IconMobile />
              <span>Mobile</span>
            </button>
          </div>
        </div>

        {/* Right: Actions (Undo, Redo, Save, Preview, Publish, More Menu, Close) */}
        <div className="npati-builder-topbar-right">
          <button
            type="button"
            className="npati-builder-icon-btn"
            onClick={undo}
            disabled={historyIndex <= 0}
            title={language === "uk" ? "Скасувати (Ctrl+Z)" : "Undo"}
          >
            <IconUndo />
          </button>
          <button
            type="button"
            className="npati-builder-icon-btn"
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            title={language === "uk" ? "Повторити (Ctrl+Y)" : "Redo"}
          >
            <IconRedo />
          </button>

          {/* SAVE BUTTON */}
          <button
            type="button"
            className="npati-builder-save-btn"
            onClick={() => void saveDocumentToProject()}
            disabled={saveStatus === "saving" || visualConfigUnavailable || (doc?.framework === "static" && staticPreviewActive)}
            title={language === "uk" ? "Зберегти зміни" : "Save changes"}
          >
            <IconSave />
            <span>{saveStatus === "saving" ? (language === "uk" ? "Збереження..." : "Saving...") : (language === "uk" ? "Зберегти" : "Save")}</span>
          </button>

          {/* PREVIEW BUTTON */}
          <button
            type="button"
            className={`npati-builder-preview-btn ${previewMode === "sandbox" ? "active" : ""}`}
            onClick={() => {
              if (doc?.framework === "static") {
                setStaticPreviewActive((active) => !active);
                return;
              }
              if (previewStatus?.isRunning) {
                setPreviewMode((m) => (m === "visual" ? "sandbox" : "visual"));
              } else {
                void handleStartPreview();
              }
            }}
            title="Toggle Live Preview"
          >
            <IconEye />
            <span>{doc?.framework === "static" ? (staticPreviewActive ? (language === "uk" ? "Конструктор" : "Visual editor") : (language === "uk" ? "Перегляд сайту" : "Site preview")) : previewMode === "sandbox" ? (language === "uk" ? "Конструктор" : "Visual View") : (language === "uk" ? "Перегляд" : "Preview")}</span>
          </button>

          {/* PUBLISH BUTTON */}
          <button
            type="button"
            className="npati-builder-publish-btn"
            onClick={() => void handleDeploy()}
            disabled={isDeploying}
          >
            <IconPublish />
            <span>{isDeploying ? (language === "uk" ? "Публікація..." : "Publishing...") : (language === "uk" ? "Опублікувати" : "Publish")}</span>
          </button>

          {/* More options menu */}
          <div style={{ position: "relative" }} ref={moreMenuRef}>
            <button
              type="button"
              className="npati-builder-icon-btn"
              onClick={() => setMoreMenuOpen((o) => !o)}
              title="More Options"
            >
              <IconMore />
            </button>

            {moreMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: "6px",
                  width: "210px",
                  background: "#ffffff",
                  borderRadius: "10px",
                  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.12)",
                  border: "1px solid #e2e8f0",
                  padding: "6px",
                  zIndex: 100,
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                }}
              >
                <button
                  type="button"
                  onClick={() => { setMoreMenuOpen(false); setActiveDrawer("ai"); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#0f172a",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconSparkles />
                  <span>AI Developer Agent</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setMoreMenuOpen(false); setActiveDrawer("files"); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#0f172a",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconFile />
                  <span>Project Files & Code</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setMoreMenuOpen(false); setActiveDrawer("history"); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#0f172a",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconGrip />
                  <span>Checkpoints & Git</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setMoreMenuOpen(false); setInspectorTab("advanced"); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#0f172a",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconPublish />
                  <span>SEO & Meta Tags</span>
                </button>
              </div>
            )}
          </div>

          {/* Close button matching project style */}
          <Link
            to="/settings/websites"
            className="npati-builder-close-btn"
            title={language === "uk" ? "Закрити" : "Close"}
            aria-label="Close"
          >
            <IconClose />
          </Link>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* MAIN 3-PANEL BODY                                                         */}
      {/* ========================================================================= */}
      <div className="npati-builder-body">
        {/* ----------------------------------------------------------------------- */}
        {/* LEFT PANEL: Pages / Layers / Assets                                     */}
        {/* ----------------------------------------------------------------------- */}
        <WebsiteEditorLeftPanel
          leftTab={leftTab}
          setLeftTab={setLeftTab}
          doc={doc}
          activePageId={activePageId}
          setActivePageId={setActivePageId}
          setSelectedBlockId={setSelectedBlockId}
          openPageMenuId={openPageMenuId}
          setOpenPageMenuId={setOpenPageMenuId}
          openBlockMenuId={openBlockMenuId}
          setOpenBlockMenuId={setOpenBlockMenuId}
          handleOpenAddPageModal={handleOpenAddPageModal}
          handleOpenEditPageModal={handleOpenEditPageModal}
          handleDuplicatePage={handleDuplicatePage}
          handleMovePage={handleMovePage}
          handleDeletePage={handleDeletePage}
          setPageModal={setPageModal}
          activePage={activePage}
          selectedBlockId={selectedBlockId}
          setInspectorTab={setInspectorTab}
          addSectionMenuOpen={addSectionMenuOpen}
          setAddSectionMenuOpen={setAddSectionMenuOpen}
          handleAddBlock={handleAddBlock}
          handleDuplicateBlock={handleDuplicateBlock}
          handleMoveBlock={handleMoveBlock}
          handleToggleHideBlock={handleToggleHideBlock}
          handleDeleteBlock={handleDeleteBlock}
          uploadingAsset={uploadingAsset}
          handleUploadAsset={handleUploadAsset}
          files={files}
          selectedBlock={selectedBlock}
          handleUpdateBlockProp={handleUpdateBlockProp}
          language={language}
        />

        {/* ----------------------------------------------------------------------- */}
        {/* CENTER LIVE CANVAS                                                      */}
        {/* ----------------------------------------------------------------------- */}
        <WebsiteEditorCanvas
          doc={doc}
          staticPreviewActive={staticPreviewActive}
          language={language}
          canvasWidth={canvasWidth}
          deviceMode={deviceMode}
          staticHtml={staticHtml}
          handleStaticFrameLoad={handleStaticFrameLoad}
          staticPreviewError={staticPreviewError}
          previewMode={previewMode}
          previewStatus={previewStatus}
          iframeKey={iframeKey}
          activePage={activePage}
          activePageId={activePageId}
          setActivePageId={setActivePageId}
          selectedBlockId={selectedBlockId}
          setSelectedBlockId={setSelectedBlockId}
          setInspectorTab={setInspectorTab}
          handleUpdateBlockProp={handleUpdateBlockProp}
          visualConfigUnavailable={visualConfigUnavailable}
          setVisualConfigUnavailable={setVisualConfigUnavailable}
        />

        {/* ----------------------------------------------------------------------- */}
        {/* RIGHT PANEL: Properties / Design / Advanced                             */}
        {/* ----------------------------------------------------------------------- */}
        <WebsiteEditorInspector
          inspectorTab={inspectorTab}
          setInspectorTab={setInspectorTab}
          selectedBlock={selectedBlock}
          inspectorSubTab={inspectorSubTab}
          setInspectorSubTab={setInspectorSubTab}
          inspectorBlockMenuOpen={inspectorBlockMenuOpen}
          setInspectorBlockMenuOpen={setInspectorBlockMenuOpen}
          handleDuplicateBlock={handleDuplicateBlock}
          handleMoveBlock={handleMoveBlock}
          handleToggleHideBlock={handleToggleHideBlock}
          handleDeleteBlock={handleDeleteBlock}
          handleUpdateBlockProp={handleUpdateBlockProp}
          handleUpdateBlockStyle={handleUpdateBlockStyle}
          doc={doc}
          pushDocumentChange={pushDocumentChange}
          activePage={activePage}
          setActiveDrawer={setActiveDrawer}
          language={language}
        />
      </div>

      <WebsiteEditorDrawers
        activeDrawer={activeDrawer}
        setActiveDrawer={setActiveDrawer}
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        chatBusy={chatBusy}
        handleSendChat={handleSendChat}
        files={files}
        selectedFilePath={selectedFilePath}
        setSelectedFilePath={setSelectedFilePath}
        fileContent={fileContent}
        setFileContent={setFileContent}
        base={base}
        checkpoints={checkpoints}
        setCheckpoints={setCheckpoints}
      />

      {/* Page Modal: Add / Edit page with icon picker */}
      {pageModal.isOpen && (
        <div className="npati-builder-modal-backdrop" onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}>
          <div className="npati-builder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="npati-builder-modal-header">
              <span className="npati-builder-modal-title">
                {pageModal.mode === "add"
                  ? (language === "uk" ? "Додати нову сторінку" : "Add New Page")
                  : (language === "uk" ? "Налаштування сторінки" : "Page Settings")}
              </span>
              <button
                type="button"
                className="npati-builder-close-btn"
                onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}
                title={language === "uk" ? "Закрити" : "Close"}
              >
                <IconClose />
              </button>
            </div>
            <div className="npati-builder-modal-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="npati-builder-form-group" style={{ marginBottom: 0 }}>
                  <label className="npati-builder-form-label">
                    {language === "uk" ? "Назва сторінки" : "Page Title"}
                  </label>
                  <input
                    type="text"
                    className="npati-builder-input"
                    placeholder="e.g. Services"
                    value={pageModal.title}
                    onChange={(e) => {
                      const title = e.target.value;
                      const autoSlug = "/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                      setPageModal((p) => ({
                        ...p,
                        title,
                        slug: p.mode === "add" ? autoSlug : p.slug,
                      }));
                    }}
                    autoFocus
                  />
                </div>

                <div className="npati-builder-form-group" style={{ marginBottom: 0 }}>
                  <label className="npati-builder-form-label">
                    {language === "uk" ? "URL адреса (Slug)" : "URL Slug"}
                  </label>
                  <input
                    type="text"
                    className="npati-builder-input"
                    placeholder="/services"
                    value={pageModal.slug}
                    onChange={(e) => setPageModal((p) => ({ ...p, slug: e.target.value }))}
                  />
                </div>
              </div>

              <div className="npati-builder-form-group">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <label className="npati-builder-form-label" style={{ marginBottom: 0 }}>
                    {language === "uk" ? "Виберіть іконку" : "Select Icon"}
                  </label>
                  <span style={{ fontSize: "11.5px", color: "#64748b", fontWeight: 500 }}>
                    {
                      PAGE_ICON_OPTIONS.filter((ic) =>
                        !iconSearch || ic.label.toLowerCase().includes(iconSearch.toLowerCase()) || ic.id.includes(iconSearch.toLowerCase())
                      ).length
                    }{" "}
                    {language === "uk" ? "доступно" : "available"}
                  </span>
                </div>

                <input
                  type="text"
                  className="npati-builder-input"
                  placeholder={language === "uk" ? "Пошук іконки (Home, Services, Blog, FAQ...)" : "Search icon (Home, Services, Blog, FAQ...)"}
                  value={iconSearch}
                  onChange={(e) => setIconSearch(e.target.value)}
                  style={{ marginBottom: "6px", fontSize: "12px", padding: "7px 10px" }}
                />

                <div className="npati-builder-icon-grid">
                  {PAGE_ICON_OPTIONS.filter((ic) =>
                    !iconSearch || ic.label.toLowerCase().includes(iconSearch.toLowerCase()) || ic.id.includes(iconSearch.toLowerCase())
                  ).map((ic) => (
                    <button
                      key={ic.id}
                      type="button"
                      className={`npati-builder-icon-option ${pageModal.icon === ic.id ? "active" : ""}`}
                      onClick={() => setPageModal((p) => ({ ...p, icon: ic.id }))}
                      title={ic.label}
                    >
                      <RenderPageIcon icon={ic.id} size={15} />
                      <span>{ic.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="npati-builder-modal-footer">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setPageModal((p) => ({ ...p, isOpen: false }))}
              >
                {language === "uk" ? "Скасувати" : "Cancel"}
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={!pageModal.title.trim()}
                onClick={handleSavePageModal}
              >
                {pageModal.mode === "add"
                  ? (language === "uk" ? "Створити сторінку" : "Create Page")
                  : (language === "uk" ? "Зберегти" : "Save Changes")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

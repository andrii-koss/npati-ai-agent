import { useState } from "react";
import {
  COMPONENT_REGISTRY,
  type WebsiteDocument,
  type WebsitePage,
} from "@npati/shared";
import { confirmModal, promptModal, alertModal } from "./ConfirmDialog";
import type { PageModalState } from "./website-editor-page-modal";

export interface UseWebsiteEditorPageActionsProps {
  doc: WebsiteDocument | null;
  activePageId: string;
  setActivePageId: (id: string) => void;
  setSelectedBlockId: (id: string | null) => void;
  pushDocumentChange: (newDoc: WebsiteDocument) => void;
  language: string;
}

export function useWebsiteEditorPageActions({
  doc,
  activePageId,
  setActivePageId,
  setSelectedBlockId,
  pushDocumentChange,
  language,
}: UseWebsiteEditorPageActionsProps) {
  const [pageModal, setPageModal] = useState<PageModalState>({
    isOpen: false,
    mode: "add",
    title: "",
    slug: "",
    icon: "file",
  });
  const [iconSearch, setIconSearch] = useState("");

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
      ? pageModal.slug.startsWith("/")
        ? pageModal.slug
        : "/" + pageModal.slug
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

  return {
    pageModal,
    setPageModal,
    iconSearch,
    setIconSearch,
    handleRenameSite,
    handleOpenAddPageModal,
    handleOpenEditPageModal,
    handleSavePageModal,
    handleDuplicatePage,
    handleMovePage,
    handleDeletePage,
  };
}

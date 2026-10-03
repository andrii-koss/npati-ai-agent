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

type DeviceMode = "desktop" | "tablet" | "mobile";
type LeftPanelTab = "pages" | "layers" | "assets";
type InspectorTab = "properties" | "design" | "advanced";
type InspectorSubTab = "content" | "style";
type ActiveDrawer = null | "ai" | "files" | "history" | "seo";

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

// ---------------------------------------------------------------------------
// SVG Icon Components (Strictly professional SVG, clean & modern)
// ---------------------------------------------------------------------------
function IconBack() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function IconDesktop() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function IconTablet() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <line x1="12" x2="12.01" y1="18" y2="18" />
    </svg>
  );
}

function IconMobile() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="20" x="5" y="2" rx="2" />
      <line x1="12" x2="12.01" y1="18" y2="18" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function IconPublish() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
      <circle cx="5" cy="12" r="1.2" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" x2="12" y1="5" y2="19" />
      <line x1="5" x2="19" y1="12" y2="12" />
    </svg>
  );
}

function IconGrip() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconAlignLeft() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="21" x2="3" y1="6" y2="6" />
      <line x1="15" x2="3" y1="12" y2="12" />
      <line x1="17" x2="3" y1="18" y2="18" />
    </svg>
  );
}

function IconAlignCenter() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" x2="6" y1="6" y2="6" />
      <line x1="21" x2="3" y1="12" y2="12" />
      <line x1="18" x2="6" y1="18" y2="18" />
    </svg>
  );
}

function IconAlignRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="21" x2="3" y1="6" y2="6" />
      <line x1="21" x2="9" y1="12" y2="12" />
      <line x1="21" x2="7" y1="18" y2="18" />
    </svg>
  );
}

function IconHome({ size = 14 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconFile({ size = 14 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconSparkles({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  );
}

function IconSettings({ size = 14 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function IconArrowDown() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function IconTag({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" />
      <path d="M7 7h.01" />
    </svg>
  );
}

function IconPhone({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function IconBriefcase({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}

function IconUser({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function IconGlobe({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" x2="22" y1="12" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconMail({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function IconRocket({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function IconStar({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function IconHelp({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconShield({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconBook({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function IconCode({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function IconChart({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function IconCalendar({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function IconChat({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconAward({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="7" />
      <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
    </svg>
  );
}

function IconMapPin({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconHeart({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

function IconBell({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconImage({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function IconCart({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </svg>
  );
}

function IconCompass({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function IconBox({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconMegaphone({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 11 18-5v12L3 13v-2z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

function IconLock({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconUsers({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconCpu({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" />
      <path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" />
      <path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />
    </svg>
  );
}

function IconZap({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

const PAGE_ICON_OPTIONS = [
  { id: "home", label: "Home" },
  { id: "file", label: "Page" },
  { id: "user", label: "About" },
  { id: "bag", label: "Services" },
  { id: "tag", label: "Pricing" },
  { id: "phone", label: "Contact" },
  { id: "book", label: "Blog" },
  { id: "cart", label: "Store" },
  { id: "sparkles", label: "Features" },
  { id: "rocket", label: "Launch" },
  { id: "star", label: "Reviews" },
  { id: "help", label: "FAQ" },
  { id: "chart", label: "Stats" },
  { id: "calendar", label: "Events" },
  { id: "chat", label: "Community" },
  { id: "award", label: "Portfolio" },
  { id: "map-pin", label: "Location" },
  { id: "globe", label: "Web" },
  { id: "mail", label: "Newsletter" },
  { id: "shield", label: "Security" },
  { id: "lock", label: "Privacy" },
  { id: "code", label: "API" },
  { id: "box", label: "Products" },
  { id: "users", label: "Careers" },
  { id: "cpu", label: "Tech" },
  { id: "zap", label: "Speed" },
  { id: "image", label: "Gallery" },
  { id: "bell", label: "Updates" },
  { id: "heart", label: "Support" },
  { id: "compass", label: "Explore" },
  { id: "megaphone", label: "News" },
  { id: "settings", label: "Settings" },
];

function RenderPageIcon({ icon, isHome, size = 14 }: { icon?: string; isHome?: boolean; size?: number }) {
  if (isHome || icon === "home") return <IconHome size={size} />;
  switch (icon) {
    case "tag":
    case "pricing":
      return <IconTag size={size} />;
    case "phone":
    case "contact":
      return <IconPhone size={size} />;
    case "bag":
    case "services":
      return <IconBriefcase size={size} />;
    case "user":
    case "about":
      return <IconUser size={size} />;
    case "globe":
    case "domains":
      return <IconGlobe size={size} />;
    case "mail":
      return <IconMail size={size} />;
    case "sparkles":
      return <IconSparkles size={size} />;
    case "rocket":
      return <IconRocket size={size} />;
    case "star":
      return <IconStar size={size} />;
    case "help":
    case "faq":
      return <IconHelp size={size} />;
    case "shield":
      return <IconShield size={size} />;
    case "book":
    case "blog":
      return <IconBook size={size} />;
    case "code":
    case "api":
      return <IconCode size={size} />;
    case "chart":
      return <IconChart size={size} />;
    case "calendar":
      return <IconCalendar size={size} />;
    case "chat":
      return <IconChat size={size} />;
    case "award":
      return <IconAward size={size} />;
    case "map-pin":
      return <IconMapPin size={size} />;
    case "heart":
      return <IconHeart size={size} />;
    case "bell":
      return <IconBell size={size} />;
    case "image":
      return <IconImage size={size} />;
    case "cart":
      return <IconCart size={size} />;
    case "compass":
      return <IconCompass size={size} />;
    case "box":
      return <IconBox size={size} />;
    case "megaphone":
      return <IconMegaphone size={size} />;
    case "lock":
      return <IconLock size={size} />;
    case "users":
      return <IconUsers size={size} />;
    case "cpu":
      return <IconCpu size={size} />;
    case "zap":
      return <IconZap size={size} />;
    case "settings":
      return <IconSettings />;
    default:
      return <IconFile size={size} />;
  }
}

function IconSectionSymbol({ type }: { type: string }) {
  switch (type) {
    case "navbar":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="20" height="6" x="2" y="3" rx="1" />
          <line x1="6" x2="8" y1="6" y2="6" />
          <line x1="16" x2="18" y1="6" y2="6" />
        </svg>
      );
    case "hero":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="18" height="14" x="3" y="4" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="18" y2="21" />
        </svg>
      );
    case "features":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
        </svg>
      );
    case "pricing":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <line x1="3" x2="21" y1="12" y2="12" />
          <line x1="12" x2="12" y1="3" y2="21" />
        </svg>
      );
    case "faq":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" x2="12.01" y1="17" y2="17" />
        </svg>
      );
    case "cta":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "footer":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="20" height="6" x="2" y="15" rx="1" />
          <line x1="6" x2="18" y1="18" y2="18" />
        </svg>
      );
    default:
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="18" height="18" x="3" y="3" rx="2" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Build Initial Mockup Document (Matches attached photo exactly)
// ---------------------------------------------------------------------------
function buildMockupDocument(name: string, framework: "nextjs" | "vite" = "nextjs"): WebsiteDocument {
  const doc = createDefaultWebsiteDocument(name, framework);

  const homePage = doc.pages[0];
  if (homePage) {
    homePage.blocks = [
      {
        id: "block-navbar",
        type: "navbar",
        name: "Header",
        props: {
          brandName: "NPATI",
          logoUrl: "",
          links: [
            { text: "Home", url: "/" },
            { text: "About", url: "#about" },
            { text: "Services", url: "#services" },
            { text: "Pricing", url: "#pricing" },
            { text: "Blog", url: "#blog" },
          ],
          ctaText: "Get Started",
          ctaUrl: "#pricing",
          sticky: true,
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "small",
          paddingX: "medium",
          maxWidth: "large",
        },
      },
      {
        id: "block-hero",
        type: "hero",
        name: "Hero Section",
        props: {
          badge: "Modern websites for modern businesses",
          title: "Build stunning websites with NPATI",
          subtitle: "Create professional, high-performing websites in minutes with our powerful no-code builder. No design or coding skills required.",
          primaryCtaText: "Get Started Free",
          primaryCtaUrl: "#",
          secondaryCtaText: "Watch Demo",
          secondaryCtaUrl: "#",
          layout: "split",
        },
        styles: {
          backgroundColor: "#F8FAFF",
          textColor: "#0F172A",
          textAlign: "center",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-features",
        type: "features",
        name: "Features",
        props: {
          badge: "FEATURES",
          title: "Everything you need to succeed",
          subtitle: "Powerful features to help you build, launch, and grow your online presence.",
          items: [
            {
              title: "Drag & Drop Builder",
              description: "Create beautiful websites without any coding. Just drag, drop, and customize.",
              icon: "drag",
            },
            {
              title: "Responsive Design",
              description: "Your website looks perfect on all devices, from desktop to mobile.",
              icon: "responsive",
            },
            {
              title: "Fast Performance",
              description: "Built with modern technology for lightning-fast loading speeds.",
              icon: "fast",
            },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-how-it-works",
        type: "custom",
        name: "How It Works",
        props: {
          title: "Launch in 3 Simple Steps",
          subtitle: "Pick a template, customize components with instant live preview, and deploy to your custom domain in seconds.",
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "medium",
          maxWidth: "large",
        },
      },
      {
        id: "block-testimonials",
        type: "testimonials",
        name: "Testimonials",
        props: {
          title: "Loved by Founders & Creators",
          subtitle: "Join thousands of businesses that build their presence with NPATI AI.",
        },
        styles: {
          backgroundColor: "#F8FAFF",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-pricing",
        type: "pricing",
        name: "Pricing",
        props: {
          title: "Transparent, Flexible Plans",
          subtitle: "No hidden fees. Change or cancel your subscription at any time.",
          tiers: [
            { name: "Starter", price: "$19", description: "Essential tools for personal projects and early stage ventures." },
            { name: "Pro", price: "$49", description: "Advanced power, custom code, and priority support for growing teams." },
            { name: "Enterprise", price: "$149", description: "Full white-glove setup, custom integrations, and dedicated agent clusters." },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-faq",
        type: "faq",
        name: "FAQ",
        props: {
          title: "Frequently Asked Questions",
          items: [
            { question: "How does the visual builder work?", answer: "Click any section or text directly on the canvas to edit in place, or use the Properties panel on the right." },
            { question: "Can I connect my custom domain?", answer: "Yes, you can easily link any domain with automated SSL configuration." },
            { question: "Is hosting and CDN included?", answer: "High-speed edge CDN hosting is included with automated global distribution." },
          ],
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#0f172a",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-cta",
        type: "cta",
        name: "CTA Section",
        props: {
          title: "Ready to launch your website?",
          subtitle: "Start building today with NPATI. No design or coding skills required.",
          primaryCtaText: "Get Started Free",
          primaryCtaUrl: "#",
        },
        styles: {
          backgroundColor: "#0f172a",
          textColor: "#ffffff",
          paddingY: "large",
          maxWidth: "large",
        },
      },
      {
        id: "block-footer",
        type: "footer",
        name: "Footer",
        props: {
          brandName: "NPATI",
        },
        styles: {
          backgroundColor: "#ffffff",
          textColor: "#64748b",
          paddingY: "medium",
          maxWidth: "large",
        },
      },
    ];
  }

  // Add remaining pages matching the mockup
  if (homePage) {
    homePage.icon = "home";
    doc.pages = [
      homePage,
      { id: "page-about", title: "About", slug: "/about", icon: "user", blocks: [] },
      { id: "page-services", title: "Services", slug: "/services", icon: "bag", blocks: [] },
      { id: "page-pricing", title: "Pricing", slug: "/pricing", icon: "tag", blocks: [] },
      { id: "page-blog", title: "Blog", slug: "/blog", icon: "file", blocks: [] },
      { id: "page-contact", title: "Contact", slug: "/contact", icon: "phone", blocks: [] },
    ];
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Main WebsiteEditor Component
// ---------------------------------------------------------------------------
export function WebsiteEditor() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();

  const base = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`;

  // Core Document State
  const [doc, setDoc] = useState<WebsiteDocument | null>(null);
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

  // Load project & website config
  const loadProject = async () => {
    if (!companyId || !projectId) return;
    setLoading(true);
    try {
      try {
        const fileRes = await apiGet<{ content: string }>(`${base}/files/read?path=website.config.json`);
        const parsed = JSON.parse(fileRes.content) as WebsiteDocument;

        // If parsed doc has no blocks, enrich with mockup template
        if (!parsed.pages[0]?.blocks?.length) {
          const mockupDoc = buildMockupDocument(parsed.name, parsed.framework === "vite" ? "vite" : "nextjs");
          setDoc(mockupDoc);
          setActivePageId(mockupDoc.pages[0]?.id || "page-home");
          setSelectedBlockId(mockupDoc.pages[0]?.blocks[1]?.id || "block-hero");
          setHistory([mockupDoc]);
          setHistoryIndex(0);
          await saveDocumentToProject(mockupDoc);
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
        const proj = await apiGet<any>(base);
        const mockupDoc = buildMockupDocument(
          proj.name || "My Business Website",
          proj.framework?.toLowerCase().includes("vite") ? "vite" : "nextjs"
        );
        setDoc(mockupDoc);
        setActivePageId(mockupDoc.pages[0]?.id || "page-home");
        setSelectedBlockId(mockupDoc.pages[0]?.blocks[1]?.id || "block-hero");
        setHistory([mockupDoc]);
        setHistoryIndex(0);
        await saveDocumentToProject(mockupDoc);
      }

      await refreshPreview();
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
    } catch {}
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
    setSaveStatus("saving");
    try {
      const adapter = getWebsiteAdapter(targetDoc.framework);
      const synced = adapter.syncDocument(targetDoc);

      await apiPost(`${base}/files/write`, {
        path: "website.config.json",
        content: JSON.stringify(targetDoc, null, 2) + "\n",
      });

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
    <div className="npati-fullscreen-editor-shell">
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
            <span style={{ fontSize: "10px", opacity: 0.7, marginRight: "2px" }}>NEX</span>
            {doc?.framework === "vite" ? "VITE" : "NEXT.JS"}
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
            disabled={saveStatus === "saving"}
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
              if (previewStatus?.isRunning) {
                setPreviewMode((m) => (m === "visual" ? "sandbox" : "visual"));
              } else {
                void handleStartPreview();
              }
            }}
            title="Toggle Live Preview"
          >
            <IconEye />
            <span>{previewMode === "sandbox" ? (language === "uk" ? "Конструктор" : "Visual View") : (language === "uk" ? "Перегляд" : "Preview")}</span>
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
        <aside className="npati-builder-left-panel">
          {/* Top Segmented Tabs: Pages | Layers | Assets */}
          <div className="npati-builder-nav-tabs-wrapper">
            <div className="npati-builder-nav-tabs">
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "pages" ? "active" : ""}`}
                onClick={() => setLeftTab("pages")}
              >
                Pages
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "layers" ? "active" : ""}`}
                onClick={() => setLeftTab("layers")}
              >
                Layers
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${leftTab === "assets" ? "active" : ""}`}
                onClick={() => setLeftTab("assets")}
              >
                Assets
              </button>
            </div>
          </div>

          {/* TAB: PAGES */}
          {leftTab === "pages" && (
            <div className="npati-builder-tab-content">
              {/* Pages List */}
              <div className="npati-builder-page-list">
                {(doc?.pages || []).map((page, pIdx) => {
                  const isActive = page.id === activePageId;
                  const isHome = page.slug === "/" || page.id === "page-home";
                  return (
                    <div
                      key={page.id}
                      className={`npati-builder-page-item ${isActive ? "active" : ""}`}
                      onClick={() => {
                        setActivePageId(page.id);
                        if (page.blocks[0]) setSelectedBlockId(page.blocks[0].id);
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <RenderPageIcon icon={page.icon} isHome={isHome} />
                        <span style={{ fontWeight: isActive ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {page.title}
                        </span>
                      </div>

                      {/* Page Settings Action Popover */}
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="npati-builder-page-settings-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenPageMenuId(openPageMenuId === page.id ? null : page.id);
                          }}
                          title="Page Settings"
                        >
                          <IconSettings />
                        </button>

                        {openPageMenuId === page.id && (
                          <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleOpenEditPageModal(page);
                              }}
                            >
                              <IconEdit />
                              <span>{language === "uk" ? "Редагувати сторінку" : "Edit Page"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleDuplicatePage(page.id);
                              }}
                            >
                              <IconCopy />
                              <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleMovePage(page.id, "up");
                              }}
                              disabled={pIdx === 0}
                            >
                              <IconArrowUp />
                              <span>{language === "uk" ? "Перемістити вище" : "Move Up"}</span>
                            </button>
                            <button
                              type="button"
                              className="npati-builder-popover-item"
                              onClick={() => {
                                setOpenPageMenuId(null);
                                handleMovePage(page.id, "down");
                              }}
                              disabled={pIdx === (doc?.pages.length || 0) - 1}
                            >
                              <IconArrowDown />
                              <span>{language === "uk" ? "Перемістити нижче" : "Move Down"}</span>
                            </button>
                            {!isHome && (
                              <button
                                type="button"
                                className="npati-builder-popover-item danger"
                                onClick={() => {
                                  setOpenPageMenuId(null);
                                  void handleDeletePage(page.id);
                                }}
                              >
                                <IconTrash />
                                <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="npati-builder-add-page-btn"
                  onClick={handleOpenAddPageModal}
                >
                  <IconPlus />
                  <span>Add Page</span>
                </button>
              </div>

              {/* Sections Structure Hierarchy of current page */}
              <div className="npati-builder-sections-wrap">
                <div className="npati-builder-sections-header">
                  <span className="npati-builder-sections-title">
                    {activePage?.title || "Home"} Sections
                  </span>

                  {/* Add section plus button in same row */}
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="npati-builder-add-section-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddSectionMenuOpen((prev) => !prev);
                      }}
                      title={language === "uk" ? "Додати секцію" : "Add Section"}
                    >
                      <IconPlus />
                    </button>

                    {addSectionMenuOpen && (
                      <div className="npati-builder-action-popover section-templates-popover" onClick={(e) => e.stopPropagation()}>
                        <div className="npati-builder-popover-title">
                          {language === "uk" ? "Виберіть секцію" : "Add Section"}
                        </div>
                        {Object.entries(COMPONENT_REGISTRY).map(([type, def]) => (
                          <button
                            key={type}
                            type="button"
                            className="npati-builder-popover-item"
                            onClick={() => {
                              setAddSectionMenuOpen(false);
                              handleAddBlock(type as WebsiteBlockType);
                            }}
                          >
                            <IconSectionSymbol type={type} />
                            <span>{def.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="npati-builder-sections-list">
                  {(activePage?.blocks || []).map((b, idx) => {
                    const isSelected = selectedBlockId === b.id;
                    const def = COMPONENT_REGISTRY[b.type] || COMPONENT_REGISTRY.custom;
                    return (
                      <div
                        key={b.id}
                        className={`npati-builder-section-row ${isSelected ? "active" : ""}`}
                        onClick={() => {
                          setSelectedBlockId(b.id);
                          setInspectorTab("properties");
                        }}
                        style={{ opacity: b.isHidden ? 0.45 : 1 }}
                      >
                        <div className="npati-builder-section-info">
                          <span className="npati-builder-drag-handle">
                            <IconGrip />
                          </span>
                          <span className="npati-builder-section-icon">
                            <IconSectionSymbol type={b.type} />
                          </span>
                          <span className="npati-builder-section-name">
                            {b.name || def.title}
                          </span>
                        </div>

                        {/* 3 Dots button on each block with popover */}
                        <div style={{ position: "relative" }}>
                          <button
                            type="button"
                            className="npati-builder-more-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenBlockMenuId(openBlockMenuId === b.id ? null : b.id);
                            }}
                            title="Actions"
                          >
                            <IconMore />
                          </button>

                          {openBlockMenuId === b.id && (
                            <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleMoveBlock(b.id, "up");
                                }}
                                disabled={idx === 0}
                              >
                                <IconArrowUp />
                                <span>{language === "uk" ? "Підняти вгору" : "Move Up"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleMoveBlock(b.id, "down");
                                }}
                                disabled={idx === (activePage?.blocks.length || 0) - 1}
                              >
                                <IconArrowDown />
                                <span>{language === "uk" ? "Опустити вниз" : "Move Down"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleDuplicateBlock(b.id);
                                }}
                              >
                                <IconCopy />
                                <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  handleToggleHideBlock(b.id);
                                }}
                              >
                                {b.isHidden ? <IconEye /> : <IconEyeOff />}
                                <span>{b.isHidden ? (language === "uk" ? "Показати" : "Show") : (language === "uk" ? "Сховати" : "Hide")}</span>
                              </button>
                              <button
                                type="button"
                                className="npati-builder-popover-item danger"
                                onClick={() => {
                                  setOpenBlockMenuId(null);
                                  void handleDeleteBlock(b.id);
                                }}
                              >
                                <IconTrash />
                                <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB: LAYERS */}
          {leftTab === "layers" && (
            <div className="npati-builder-tab-content">
              <span className="npati-builder-sections-title">Document Structure</span>
              <div className="npati-builder-sections-list">
                {(activePage?.blocks || []).map((b) => (
                  <div
                    key={b.id}
                    className={`npati-builder-section-row ${selectedBlockId === b.id ? "active" : ""}`}
                    onClick={() => { setSelectedBlockId(b.id); setInspectorTab("properties"); }}
                  >
                    <div className="npati-builder-section-info">
                      <IconSectionSymbol type={b.type} />
                      <span className="npati-builder-section-name" style={{ color: "#0f172a", fontWeight: 600 }}>{b.name || b.type}</span>
                    </div>
                    <span style={{ fontSize: "11px", color: "#64748b" }}>#{b.type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB: ASSETS */}
          {leftTab === "assets" && (
            <div className="npati-builder-tab-content">
              <span className="npati-builder-sections-title">Media & Assets</span>
              <label
                className="button-primary"
                style={{ textAlign: "center", cursor: "pointer", padding: "9px 14px", fontSize: "13px" }}
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "12px" }}>
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
                          void alertModal({ message: `Copied URL: ${url}` });
                        }}
                        style={{
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          padding: "6px",
                          cursor: "pointer",
                          background: "#ffffff",
                          textAlign: "center",
                        }}
                      >
                        <img src={url} alt={f.name} style={{ width: "100%", height: "65px", objectFit: "cover", borderRadius: "4px" }} />
                        <span style={{ fontSize: "11px", color: "#0f172a", fontWeight: 500, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.name}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </aside>

        {/* ----------------------------------------------------------------------- */}
        {/* CENTER LIVE CANVAS                                                      */}
        {/* ----------------------------------------------------------------------- */}
        <main className="npati-builder-canvas-wrapper">
          <div
            className="npati-builder-canvas-card"
            style={{
              width: canvasWidth,
              maxWidth: deviceMode === "desktop" ? "1240px" : canvasWidth,
            }}
          >
            {/* If sandbox mode is chosen and sandbox preview is active */}
            {previewMode === "sandbox" && previewStatus?.previewUrl ? (
              <iframe
                key={iframeKey}
                src={previewStatus.previewUrl}
                title="Website Live Preview"
                style={{ width: "100%", height: "100%", minHeight: "800px", border: "none" }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            ) : (
              /* Rich Interactive Visual Canvas with In-line text editing */
              <div style={{ display: "flex", flexDirection: "column", width: "100%", minHeight: "100%" }}>
                {(activePage?.blocks || []).map((b) => {
                  if (b.isHidden) return null;
                  const isSelected = selectedBlockId === b.id;
                  const def = COMPONENT_REGISTRY[b.type] || COMPONENT_REGISTRY.custom;
                  const p = b.props || {};
                  const s = b.styles || {};

                  return (
                    <div
                      key={b.id}
                      className={`npati-builder-canvas-block ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedBlockId(b.id);
                        setInspectorTab("properties");
                      }}
                      style={{
                        backgroundColor: s.backgroundColor || "transparent",
                        color: s.textColor || "#0f172a",
                        textAlign: s.textAlign || "left",
                        padding: s.paddingY === "xlarge" ? "80px 32px" : s.paddingY === "large" ? "64px 32px" : s.paddingY === "small" ? "20px 32px" : s.paddingY === "none" ? "0 32px" : "44px 32px",
                      }}
                    >
                      {/* Floating selection pill tag matching mockup */}
                      {isSelected && (
                        <div className="npati-builder-selected-tag">
                          <span>{b.name || def.title}</span>
                          <span style={{ opacity: 0.85, cursor: "pointer" }}>···</span>
                        </div>
                      )}

                      {/* 1. NAVBAR */}
                      {b.type === "navbar" && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: "1140px", margin: "0 auto", width: "100%" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 800, fontSize: "20px", color: s.textColor || "#0f172a" }}>
                            {p.logoUrl ? (
                              <img src={p.logoUrl} alt={p.brandName} style={{ height: "30px" }} />
                            ) : (
                              <span style={{ display: "inline-block", width: "11px", height: "11px", borderRadius: "50%", background: "#e11d2e" }} />
                            )}
                            <span
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("brandName", e.currentTarget.textContent || "")}
                            >
                              {p.brandName || doc?.name || "NPATI"}
                            </span>
                          </div>

                          <nav style={{ display: "flex", gap: "28px", alignItems: "center", fontSize: "14.5px", fontWeight: 500 }}>
                            {(p.links || [{ text: "Home" }, { text: "About" }, { text: "Services" }, { text: "Pricing" }, { text: "Blog" }]).map((link: any, i: number) => (
                              <span key={i} style={{ color: "#334155", cursor: "pointer" }}>{link.text}</span>
                            ))}
                          </nav>

                          {p.ctaText && (
                            <button
                              type="button"
                              className="button-primary"
                              style={{ background: "#0f172a", borderColor: "#0f172a", padding: "8px 18px", fontSize: "13.5px" }}
                            >
                              {p.ctaText}
                            </button>
                          )}
                        </div>
                      )}

                      {/* 2. HERO SECTION */}
                      {b.type === "hero" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", textAlign: s.textAlign || "left" }}>
                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "1.2fr 1fr", gap: "40px", alignItems: "center" }}>
                            <div>
                              {p.badge && (
                                <div
                                  className="npati-editable-text"
                                  contentEditable={isSelected}
                                  suppressContentEditableWarning={true}
                                  onBlur={(e) => handleUpdateBlockProp("badge", e.currentTarget.textContent || "")}
                                  style={{
                                    display: "inline-block",
                                    padding: "5px 14px",
                                    borderRadius: "999px",
                                    background: "#fef2f2",
                                    color: "#e11d2e",
                                    fontSize: "12.5px",
                                    fontWeight: 600,
                                    marginBottom: "18px",
                                    border: "1px solid #fee2e2",
                                  }}
                                >
                                  {p.badge}
                                </div>
                              )}

                              <h1
                                className="npati-editable-text"
                                contentEditable={isSelected}
                                suppressContentEditableWarning={true}
                                onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                                style={{
                                  fontSize: "clamp(2.2rem, 4.2vw, 3.4rem)",
                                  fontWeight: 800,
                                  lineHeight: 1.15,
                                  margin: "0 0 18px 0",
                                  color: s.textColor || "#0f172a",
                                  letterSpacing: "-0.03em",
                                }}
                              >
                                {p.title || "Build stunning websites with NPATI"}
                              </h1>

                              <p
                                className="npati-editable-text"
                                contentEditable={isSelected}
                                suppressContentEditableWarning={true}
                                onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                                style={{
                                  fontSize: "16px",
                                  lineHeight: 1.6,
                                  color: "#334155",
                                  margin: "0 0 28px 0",
                                  maxWidth: "540px",
                                }}
                              >
                                {p.subtitle || "Create professional, high-performing websites in minutes with our powerful no-code builder. No design or coding skills required."}
                              </p>

                              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                                {p.primaryCtaText && (
                                  <button
                                    type="button"
                                    className="button-primary"
                                    style={{ background: "#0f172a", borderColor: "#0f172a", padding: "11px 22px", fontSize: "14px", fontWeight: 700 }}
                                  >
                                    {p.primaryCtaText} →
                                  </button>
                                )}
                                {p.secondaryCtaText && (
                                  <button
                                    type="button"
                                    className="button-secondary"
                                    style={{ padding: "11px 22px", fontSize: "14px", display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600, color: "#0f172a" }}
                                  >
                                    <span style={{ fontSize: "11px" }}>▷</span> {p.secondaryCtaText}
                                  </button>
                                )}
                              </div>

                              <div style={{ display: "flex", gap: "20px", marginTop: "28px", fontSize: "13px", color: "#334155", fontWeight: 500 }}>
                                <span>✓ No credit card required</span>
                                <span>✓ Drag & drop builder</span>
                                <span>✓ Publish in minutes</span>
                              </div>
                            </div>

                            {/* Hero Visual Mockup Illustration (Browser Card + Smartphone Mockup) */}
                            <div style={{ position: "relative", minHeight: "340px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {/* Browser Frame */}
                              <div
                                style={{
                                  width: "92%",
                                  background: "#ffffff",
                                  borderRadius: "16px",
                                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.12)",
                                  border: "1px solid #e2e8f0",
                                  overflow: "hidden",
                                }}
                              >
                                {/* Browser Window Header */}
                                <div style={{ background: "#f8fafc", padding: "10px 14px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: "6px" }}>
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f87171" }} />
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fbbf24" }} />
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399" }} />
                                </div>
                                <div style={{ padding: "20px" }}>
                                  <div style={{ fontWeight: 800, fontSize: "18px", color: "#0f172a", marginBottom: "6px" }}>Grow your business online</div>
                                  <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "16px" }}>Beautiful websites. Real results.</div>
                                  <div style={{ height: "130px", background: "linear-gradient(135deg, #e0e7ff 0%, #fae8ff 100%)", borderRadius: "10px", display: "grid", placeItems: "center" }}>
                                    <button type="button" className="button-primary" style={{ padding: "6px 14px", fontSize: "11px", background: "#4f46e5", borderColor: "#4f46e5" }}>Get Started</button>
                                  </div>
                                </div>
                              </div>

                              {/* Overlapping Smartphone Mockup */}
                              <div
                                style={{
                                  position: "absolute",
                                  bottom: "-10px",
                                  right: "0px",
                                  width: "160px",
                                  background: "#ffffff",
                                  borderRadius: "22px",
                                  border: "4px solid #0f172a",
                                  boxShadow: "0 20px 35px rgba(0, 0, 0, 0.18)",
                                  padding: "10px",
                                  zIndex: 5,
                                }}
                              >
                                <div style={{ width: "30px", height: "4px", background: "#cbd5e1", borderRadius: "2px", margin: "0 auto 8px auto" }} />
                                <div style={{ fontSize: "11px", fontWeight: 700, color: "#0f172a" }}>Grow your business online</div>
                                <div style={{ height: "65px", background: "#f1f5f9", borderRadius: "8px", margin: "6px 0", display: "grid", placeItems: "center" }}>
                                  <button type="button" className="button-primary" style={{ padding: "4px 8px", fontSize: "9px", background: "#4f46e5", borderColor: "#4f46e5" }}>Get Started</button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 3. FEATURES */}
                      {b.type === "features" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%" }}>
                          <div style={{ textAlign: "center", marginBottom: "36px" }}>
                            <span style={{ fontSize: "11px", fontWeight: 700, color: "#e11d2e", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                              {p.badge || "FEATURES"}
                            </span>
                            <h2
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                              style={{ fontSize: "28px", fontWeight: 800, margin: "6px 0 10px 0", color: s.textColor || "#0f172a" }}
                            >
                              {p.title || "Everything you need to succeed"}
                            </h2>
                            <p
                              className="npati-editable-text"
                              contentEditable={isSelected}
                              suppressContentEditableWarning={true}
                              onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                              style={{ color: "#334155", fontSize: "15px", margin: 0 }}
                            >
                              {p.subtitle || "Powerful features to help you build, launch, and grow your online presence."}
                            </p>
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "repeat(3, 1fr)", gap: "20px" }}>
                            {(p.items || [
                              { title: "Drag & Drop Builder", description: "Create beautiful websites without any coding. Just drag, drop, and customize." },
                              { title: "Responsive Design", description: "Your website looks perfect on all devices, from desktop to mobile." },
                              { title: "Fast Performance", description: "Built with modern technology for lightning-fast loading speeds." },
                            ]).map((item: any, i: number) => (
                              <div
                                key={i}
                                style={{
                                  background: "#ffffff",
                                  border: "1px solid #e2e8f0",
                                  borderRadius: "14px",
                                  padding: "24px",
                                  boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
                                }}
                              >
                                <div style={{ width: "38px", height: "38px", borderRadius: "10px", background: i === 0 ? "#eff6ff" : i === 1 ? "#ecfdf5" : "#fdf2f8", display: "grid", placeItems: "center", marginBottom: "16px", color: i === 0 ? "#2563eb" : i === 1 ? "#059669" : "#db2777" }}>
                                  <IconSectionSymbol type="features" />
                                </div>
                                <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 8px 0", color: "#0f172a" }}>{item.title}</h3>
                                <p style={{ fontSize: "13.5px", color: "#334155", margin: 0, lineHeight: 1.5 }}>{item.description}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 4. PRICING */}
                      {b.type === "pricing" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", textAlign: "center" }}>
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "28px", fontWeight: 800, margin: "0 0 10px 0", color: s.textColor || "#0f172a" }}
                          >
                            {p.title || "Transparent, Flexible Plans"}
                          </h2>
                          <p style={{ color: "#334155", fontSize: "15px", marginBottom: "36px" }}>
                            {p.subtitle || "No hidden fees. Change or cancel your subscription at any time."}
                          </p>
                          <div style={{ display: "grid", gridTemplateColumns: deviceMode === "mobile" ? "1fr" : "repeat(3, 1fr)", gap: "20px" }}>
                            {(p.tiers || [
                              { name: "Starter", price: "$19", description: "Essential tools for personal projects." },
                              { name: "Pro", price: "$49", description: "Advanced power for growing businesses." },
                              { name: "Enterprise", price: "$149", description: "Full white-glove setup and dedicated support." },
                            ]).map((tier: any, i: number) => (
                              <div
                                key={i}
                                style={{
                                  background: "#ffffff",
                                  border: i === 1 ? "2px solid #e11d2e" : "1px solid #cbd5e1",
                                  borderRadius: "14px",
                                  padding: "28px 24px",
                                  textAlign: "left",
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
                                }}
                              >
                                <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 6px 0", color: "#0f172a" }}>{tier.name}</h3>
                                <div style={{ fontSize: "32px", fontWeight: 800, color: "#0f172a", margin: "12px 0" }}>
                                  {tier.price}<span style={{ fontSize: "14px", color: "#64748b", fontWeight: 500 }}>/mo</span>
                                </div>
                                <p style={{ fontSize: "13.5px", color: "#334155", marginBottom: "20px" }}>{tier.description}</p>
                                <button
                                  type="button"
                                  className={i === 1 ? "button-primary" : "button-secondary"}
                                  style={{ width: "100%", padding: "10px", fontWeight: 600 }}
                                >
                                  Get Started
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 5. FAQ */}
                      {b.type === "faq" && (
                        <div style={{ maxWidth: "800px", margin: "0 auto", width: "100%" }}>
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "28px", fontWeight: 800, textAlign: "center", margin: "0 0 24px 0", color: s.textColor || "#0f172a" }}
                          >
                            {p.title || "Frequently Asked Questions"}
                          </h2>
                          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            {(p.items || [
                              { question: "How does the visual builder work?", answer: "Click any section or text directly on the canvas to edit in place, or use the Properties panel on the right." },
                              { question: "Can I connect my custom domain?", answer: "Yes, you can link any custom domain with automated SSL configuration." },
                              { question: "Is hosting included?", answer: "Fast edge CDN hosting is included with all plans." },
                            ]).map((item: any, i: number) => (
                              <div key={i} style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "10px", padding: "16px 20px" }}>
                                <div style={{ fontWeight: 700, fontSize: "15px", color: "#0f172a", marginBottom: "6px" }}>{item.question}</div>
                                <div style={{ fontSize: "14px", color: "#334155", lineHeight: 1.5 }}>{item.answer}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 6. CTA */}
                      {b.type === "cta" && (
                        <div
                          style={{
                            maxWidth: "1140px",
                            margin: "0 auto",
                            width: "100%",
                            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
                            borderRadius: "20px",
                            padding: "48px 32px",
                            textAlign: "center",
                            color: "#ffffff",
                          }}
                        >
                          <h2
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("title", e.currentTarget.textContent || "")}
                            style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 12px 0", color: "#ffffff" }}
                          >
                            {p.title || "Ready to launch your website?"}
                          </h2>
                          <p
                            className="npati-editable-text"
                            contentEditable={isSelected}
                            suppressContentEditableWarning={true}
                            onBlur={(e) => handleUpdateBlockProp("subtitle", e.currentTarget.textContent || "")}
                            style={{ fontSize: "16px", color: "#cbd5e1", maxWidth: "540px", margin: "0 auto 28px auto" }}
                          >
                            {p.subtitle || "Start building today with NPATI. No design or coding skills required."}
                          </p>
                          <button
                            type="button"
                            className="button-primary"
                            style={{ background: "#e11d2e", borderColor: "#e11d2e", padding: "12px 28px", fontSize: "15px", fontWeight: 700 }}
                          >
                            {p.primaryCtaText || "Get Started Free"} →
                          </button>
                        </div>
                      )}

                      {/* 7. FOOTER */}
                      {b.type === "footer" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", borderTop: "1px solid #e2e8f0", paddingTop: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13.5px", color: "#475569" }}>
                          <div>© {new Date().getFullYear()} {p.brandName || doc?.name || "NPATI"}. All rights reserved.</div>
                          <div style={{ display: "flex", gap: "24px", fontWeight: 500 }}>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Privacy Policy</span>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Terms of Service</span>
                            <span style={{ cursor: "pointer", color: "#0f172a" }}>Contact</span>
                          </div>
                        </div>
                      )}

                      {/* 8. CUSTOM / FALLBACK */}
                      {b.type !== "navbar" && b.type !== "hero" && b.type !== "features" && b.type !== "pricing" && b.type !== "faq" && b.type !== "cta" && b.type !== "footer" && (
                        <div style={{ maxWidth: "1140px", margin: "0 auto", width: "100%", padding: "28px", background: "#ffffff", borderRadius: "14px", border: "1px solid #cbd5e1" }}>
                          <h3 style={{ margin: "0 0 8px 0", color: "#0f172a", fontWeight: 700 }}>{b.name || def.title}</h3>
                          <p style={{ margin: 0, color: "#334155" }}>{p.title || p.text || p.subtitle || "Section content..."}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* ----------------------------------------------------------------------- */}
        {/* RIGHT PANEL: Properties / Design / Advanced                             */}
        {/* ----------------------------------------------------------------------- */}
        <aside className="npati-builder-right-panel">
          {/* Top Segmented Tabs: Properties | Design | Advanced */}
          <div className="npati-builder-nav-tabs-wrapper">
            <div className="npati-builder-nav-tabs">
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "properties" ? "active" : ""}`}
                onClick={() => setInspectorTab("properties")}
              >
                Properties
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "design" ? "active" : ""}`}
                onClick={() => setInspectorTab("design")}
              >
                Design
              </button>
              <button
                type="button"
                className={`npati-builder-nav-tab ${inspectorTab === "advanced" ? "active" : ""}`}
                onClick={() => setInspectorTab("advanced")}
              >
                Advanced
              </button>
            </div>
          </div>

          {/* TAB: PROPERTIES */}
          {inspectorTab === "properties" && selectedBlock && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
              {/* Active Section Card matching mockup */}
              <div className="npati-builder-inspector-section-card">
                <div className="npati-builder-inspector-block-title">
                  <div className="npati-builder-inspector-icon-box">
                    <IconSectionSymbol type={selectedBlock.type} />
                  </div>
                  <div>
                    <strong>{selectedBlock.name || selectedBlock.type}</strong>
                    <small>#{selectedBlock.type}</small>
                  </div>
                </div>

                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="npati-builder-more-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInspectorBlockMenuOpen((prev) => !prev);
                    }}
                    title="Block Actions"
                  >
                    <IconMore />
                  </button>

                  {inspectorBlockMenuOpen && (
                    <div className="npati-builder-action-popover" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={async () => {
                          setInspectorBlockMenuOpen(false);
                          const newName = await promptModal({
                            message: language === "uk" ? "Введіть нову назву для секції:" : "Enter new name for section:",
                            defaultValue: selectedBlock.name || selectedBlock.type,
                          });
                          if (newName && newName.trim()) {
                            handleUpdateBlockProp("_sectionName", newName.trim());
                            if (activePage && doc) {
                              const updatedBlocks = activePage.blocks.map((blk) =>
                                blk.id === selectedBlock.id ? { ...blk, name: newName.trim() } : blk
                              );
                              const updatedPages = doc.pages.map((pg) =>
                                pg.id === activePage.id ? { ...pg, blocks: updatedBlocks } : pg
                              );
                              pushDocumentChange({ ...doc, pages: updatedPages });
                            }
                          }
                        }}
                      >
                        <IconEdit />
                        <span>{language === "uk" ? "Перейменувати" : "Rename"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleMoveBlock(selectedBlock.id, "up");
                        }}
                        disabled={activePage?.blocks.findIndex((x) => x.id === selectedBlock.id) === 0}
                      >
                        <IconArrowUp />
                        <span>{language === "uk" ? "Підняти вгору" : "Move Up"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleMoveBlock(selectedBlock.id, "down");
                        }}
                        disabled={
                          activePage?.blocks.findIndex((x) => x.id === selectedBlock.id) ===
                          (activePage?.blocks.length || 0) - 1
                        }
                      >
                        <IconArrowDown />
                        <span>{language === "uk" ? "Опустити вниз" : "Move Down"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleDuplicateBlock(selectedBlock.id);
                        }}
                      >
                        <IconCopy />
                        <span>{language === "uk" ? "Скопіювати" : "Duplicate"}</span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          handleToggleHideBlock(selectedBlock.id);
                        }}
                      >
                        {selectedBlock.isHidden ? <IconEye /> : <IconEyeOff />}
                        <span>
                          {selectedBlock.isHidden
                            ? (language === "uk" ? "Показати" : "Show")
                            : (language === "uk" ? "Сховати" : "Hide")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="npati-builder-popover-item danger"
                        onClick={() => {
                          setInspectorBlockMenuOpen(false);
                          void handleDeleteBlock(selectedBlock.id);
                        }}
                      >
                        <IconTrash />
                        <span>{language === "uk" ? "Видалити" : "Delete"}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Pill Subtabs: Content vs Style */}
              <div className="npati-builder-subtab-segmented">
                <button
                  type="button"
                  className={`npati-builder-subtab-btn ${inspectorSubTab === "content" ? "active" : ""}`}
                  onClick={() => setInspectorSubTab("content")}
                >
                  Content
                </button>
                <button
                  type="button"
                  className={`npati-builder-subtab-btn ${inspectorSubTab === "style" ? "active" : ""}`}
                  onClick={() => setInspectorSubTab("style")}
                >
                  Style
                </button>
              </div>

              {/* Inspector Content */}
              <div className="npati-builder-inspector-content">
                {/* SUBTAB: CONTENT */}
                {inspectorSubTab === "content" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {/* 1. Title */}
                    <div className="npati-builder-form-group">
                      <label className="npati-builder-form-label">Title</label>
                      <input
                        type="text"
                        className="npati-builder-input"
                        value={selectedBlock.props.title || selectedBlock.props.brandName || ""}
                        onChange={(e) => {
                          if (selectedBlock.type === "navbar") {
                            handleUpdateBlockProp("brandName", e.target.value);
                          } else {
                            handleUpdateBlockProp("title", e.target.value);
                          }
                        }}
                      />
                    </div>

                    {/* 2. Subtitle */}
                    {selectedBlock.type !== "navbar" && (
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Subtitle</label>
                        <textarea
                          rows={3}
                          className="npati-builder-textarea"
                          value={selectedBlock.props.subtitle || selectedBlock.props.description || ""}
                          onChange={(e) => handleUpdateBlockProp("subtitle", e.target.value)}
                        />
                      </div>
                    )}

                    {/* 3. Primary Button & Link (2-column layout matching photo) */}
                    <div className="npati-builder-btn-link-row">
                      <div className="npati-builder-form-group npati-builder-btn-col">
                        <label className="npati-builder-form-label">Primary Button</label>
                        <input
                          type="text"
                          className="npati-builder-input"
                          value={selectedBlock.props.primaryCtaText || selectedBlock.props.ctaText || "Get Started Free"}
                          onChange={(e) => {
                            if (selectedBlock.type === "navbar") {
                              handleUpdateBlockProp("ctaText", e.target.value);
                            } else {
                              handleUpdateBlockProp("primaryCtaText", e.target.value);
                            }
                          }}
                        />
                      </div>
                      <div className="npati-builder-form-group npati-builder-link-col">
                        <label className="npati-builder-form-label">Link</label>
                        <div className="npati-builder-link-input-wrap">
                          <input
                            type="text"
                            className="npati-builder-input"
                            value={selectedBlock.props.primaryCtaUrl || selectedBlock.props.ctaUrl || "#"}
                            onChange={(e) => {
                              if (selectedBlock.type === "navbar") {
                                handleUpdateBlockProp("ctaUrl", e.target.value);
                              } else {
                                handleUpdateBlockProp("primaryCtaUrl", e.target.value);
                              }
                            }}
                          />
                          <span className="link-icon">
                            <IconLink />
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 4. Secondary Button & Link (2-column layout matching photo) */}
                    {selectedBlock.type === "hero" && (
                      <div className="npati-builder-btn-link-row">
                        <div className="npati-builder-form-group npati-builder-btn-col">
                          <label className="npati-builder-form-label">Secondary Button</label>
                          <input
                            type="text"
                            className="npati-builder-input"
                            value={selectedBlock.props.secondaryCtaText || "Watch Demo"}
                            onChange={(e) => handleUpdateBlockProp("secondaryCtaText", e.target.value)}
                          />
                        </div>
                        <div className="npati-builder-form-group npati-builder-link-col">
                          <label className="npati-builder-form-label">Link</label>
                          <div className="npati-builder-link-input-wrap">
                            <input
                              type="text"
                              className="npati-builder-input"
                              value={selectedBlock.props.secondaryCtaUrl || "#"}
                              onChange={(e) => handleUpdateBlockProp("secondaryCtaUrl", e.target.value)}
                            />
                            <span className="link-icon">
                              <IconLink />
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 5. Layout Section matching photo */}
                    <div>
                      <span className="npati-builder-group-title">Layout</span>

                      {/* Alignment */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Alignment</label>
                        <div className="npati-builder-align-group">
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "left" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "left")}
                            title="Align Left"
                          >
                            <IconAlignLeft />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "center" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "center")}
                            title="Align Center"
                          >
                            <IconAlignCenter />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "right" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "right")}
                            title="Align Right"
                          >
                            <IconAlignRight />
                          </button>
                        </div>
                      </div>

                      {/* Padding */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Padding</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.paddingY || "large"}
                          onChange={(e) => handleUpdateBlockStyle("paddingY", e.target.value)}
                        >
                          <option value="none">None (0px)</option>
                          <option value="small">Small (20px)</option>
                          <option value="medium">Medium (40px)</option>
                          <option value="large">Large (64px)</option>
                          <option value="xlarge">X-Large (80px)</option>
                        </select>
                      </div>

                      {/* Max Width */}
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Max Width</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.maxWidth || "large"}
                          onChange={(e) => handleUpdateBlockStyle("maxWidth", e.target.value)}
                        >
                          <option value="large">1200px</option>
                          <option value="medium">960px</option>
                          <option value="small">640px</option>
                          <option value="full">100% Full Width</option>
                        </select>
                      </div>
                    </div>

                    {/* 6. Colors Section matching photo */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Colors</span>

                      {/* Background Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Background</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.backgroundColor?.startsWith("#") ? selectedBlock.styles.backgroundColor : "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.backgroundColor || "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Title Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Title</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.textColor?.startsWith("#") ? selectedBlock.styles.textColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.textColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Subtitle Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Subtitle</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value="#64748B"
                            onChange={(e) => handleUpdateBlockStyle("accentColor" as any, e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value="#64748B"
                            readOnly
                          />
                        </div>
                      </div>

                      {/* Primary Button Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Primary Button</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value="#0F172A"
                            onChange={(e) => handleUpdateBlockStyle("borderColor" as any, e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value="#0F172A"
                            readOnly
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* SUBTAB: STYLE */}
                {inspectorSubTab === "style" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {/* 1. Layout & Alignment */}
                    <div>
                      <span className="npati-builder-group-title">Layout & Spacing</span>

                      {/* Alignment */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Alignment</label>
                        <div className="npati-builder-align-group">
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "left" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "left")}
                            title="Align Left"
                          >
                            <IconAlignLeft />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "center" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "center")}
                            title="Align Center"
                          >
                            <IconAlignCenter />
                          </button>
                          <button
                            type="button"
                            className={`npati-builder-align-btn ${selectedBlock.styles?.textAlign === "right" ? "active" : ""}`}
                            onClick={() => handleUpdateBlockStyle("textAlign", "right")}
                            title="Align Right"
                          >
                            <IconAlignRight />
                          </button>
                        </div>
                      </div>

                      {/* Vertical Spacing / Padding */}
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Vertical Padding</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.paddingY || "large"}
                          onChange={(e) => handleUpdateBlockStyle("paddingY", e.target.value)}
                        >
                          <option value="none">None (0px)</option>
                          <option value="small">Small (24px)</option>
                          <option value="medium">Medium (48px)</option>
                          <option value="large">Large (72px)</option>
                          <option value="xlarge">Extra Large (96px)</option>
                        </select>
                      </div>

                      {/* Container Max Width */}
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Max Width</label>
                        <select
                          className="npati-builder-select"
                          value={selectedBlock.styles?.maxWidth || "large"}
                          onChange={(e) => handleUpdateBlockStyle("maxWidth", e.target.value)}
                        >
                          <option value="large">1200px (Default)</option>
                          <option value="medium">960px (Contained)</option>
                          <option value="small">640px (Narrow)</option>
                          <option value="full">100% (Full Width)</option>
                        </select>
                      </div>
                    </div>

                    {/* 2. Color Palette */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Color Palette</span>

                      {/* Background Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Background</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.backgroundColor?.startsWith("#") ? selectedBlock.styles.backgroundColor : "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.backgroundColor || "#F8FAFF"}
                            onChange={(e) => handleUpdateBlockStyle("backgroundColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Quick palette preset chips */}
                      <div className="npati-builder-palette-chips">
                        {["#ffffff", "#F8FAFF", "#F1F5F9", "#0F172A", "#e11d2e"].map((c) => (
                          <button
                            key={c}
                            type="button"
                            className="npati-builder-palette-chip"
                            style={{ background: c }}
                            onClick={() => handleUpdateBlockStyle("backgroundColor", c)}
                            title={c}
                          />
                        ))}
                      </div>

                      {/* Title Color */}
                      <div className="npati-builder-color-row" style={{ marginTop: "10px" }}>
                        <span className="npati-builder-color-label">Title Color</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.textColor?.startsWith("#") ? selectedBlock.styles.textColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.textColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("textColor", e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Subtitle / Body Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Body Text</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.accentColor?.startsWith("#") ? selectedBlock.styles.accentColor : "#475569"}
                            onChange={(e) => handleUpdateBlockStyle("accentColor" as any, e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.accentColor || "#475569"}
                            onChange={(e) => handleUpdateBlockStyle("accentColor" as any, e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Primary Button Color */}
                      <div className="npati-builder-color-row">
                        <span className="npati-builder-color-label">Button Color</span>
                        <div className="npati-builder-color-picker-wrap">
                          <input
                            type="color"
                            className="npati-builder-color-swatch"
                            value={selectedBlock.styles?.borderColor?.startsWith("#") ? selectedBlock.styles.borderColor : "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("borderColor" as any, e.target.value)}
                          />
                          <input
                            type="text"
                            className="npati-builder-color-code-input"
                            value={selectedBlock.styles?.borderColor || "#0F172A"}
                            onChange={(e) => handleUpdateBlockStyle("borderColor" as any, e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* 3. Typography */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Typography</span>
                      <div className="npati-builder-form-group" style={{ marginBottom: "12px" }}>
                        <label className="npati-builder-form-label">Font Family</label>
                        <select
                          className="npati-builder-select"
                          value={doc?.theme?.fontFamily || "inter"}
                          onChange={(e) => {
                            if (doc) {
                              pushDocumentChange({
                                ...doc,
                                theme: { ...doc.theme, fontFamily: e.target.value as any },
                              });
                            }
                          }}
                        >
                          <option value="inter">Inter (Clean Modern)</option>
                          <option value="roboto">Roboto (Geometric)</option>
                          <option value="playfair">Playfair Display (Serif)</option>
                          <option value="geist">Geist (Minimalist)</option>
                          <option value="system">System Default</option>
                        </select>
                      </div>

                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Title Weight</label>
                        <select
                          className="npati-builder-select"
                          defaultValue="800"
                          onChange={(e) => handleUpdateBlockProp("_headingWeight", e.target.value)}
                        >
                          <option value="600">Semi-Bold (600)</option>
                          <option value="700">Bold (700)</option>
                          <option value="800">Extra Bold (800)</option>
                        </select>
                      </div>
                    </div>

                    {/* 4. Borders & Corners */}
                    <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "14px" }}>
                      <span className="npati-builder-group-title">Borders & Corners</span>
                      <div className="npati-builder-form-group">
                        <label className="npati-builder-form-label">Corner Radius</label>
                        <select
                          className="npati-builder-select"
                          defaultValue="md"
                          onChange={(e) => {
                            if (doc) {
                              pushDocumentChange({
                                ...doc,
                                theme: { ...doc.theme, borderRadius: e.target.value as any },
                              });
                            }
                          }}
                        >
                          <option value="none">Sharp (0px)</option>
                          <option value="sm">Small (6px)</option>
                          <option value="md">Rounded (12px)</option>
                          <option value="lg">Large (18px)</option>
                          <option value="full">Pill / Full</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: DESIGN (Global Website Styles) */}
          {inspectorTab === "design" && doc && (
            <div className="npati-builder-inspector-content">
              <span className="npati-builder-sections-title">Global Website Styles</span>

              <div className="npati-builder-color-row">
                <span className="npati-builder-color-label">Primary Brand Color</span>
                <div className="npati-builder-color-picker-wrap">
                  <input
                    type="color"
                    className="npati-builder-color-swatch"
                    value={doc.theme.primaryColor || "#e11d2e"}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, primaryColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                  />
                  <input
                    type="text"
                    className="npati-builder-color-code-input"
                    value={doc.theme.primaryColor || "#E11D2E"}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, primaryColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                  />
                </div>
              </div>

              <div className="npati-builder-color-row">
                <span className="npati-builder-color-label">Background Color</span>
                <div className="npati-builder-color-picker-wrap">
                  <input
                    type="color"
                    className="npati-builder-color-swatch"
                    value={doc.theme.backgroundColor || "#ffffff"}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, backgroundColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                  />
                  <input
                    type="text"
                    className="npati-builder-color-code-input"
                    value={doc.theme.backgroundColor || "#FFFFFF"}
                    onChange={(e) => {
                      pushDocumentChange({
                        ...doc,
                        theme: { ...doc.theme, backgroundColor: e.target.value },
                        updatedAt: new Date().toISOString(),
                      });
                    }}
                  />
                </div>
              </div>

              <div className="npati-builder-form-group">
                <label className="npati-builder-form-label">Font Family</label>
                <select
                  className="npati-builder-select"
                  value={doc.theme.fontFamily || "inter"}
                  onChange={(e) => {
                    pushDocumentChange({
                      ...doc,
                      theme: { ...doc.theme, fontFamily: e.target.value as any },
                      updatedAt: new Date().toISOString(),
                    });
                  }}
                >
                  <option value="inter">Inter (Modern Clean)</option>
                  <option value="roboto">Roboto</option>
                  <option value="geist">Geist Sans</option>
                  <option value="playfair">Playfair Display (Editorial)</option>
                  <option value="system">System Default</option>
                </select>
              </div>

              <div className="npati-builder-form-group">
                <label className="npati-builder-form-label">Global Border Radius</label>
                <select
                  className="npati-builder-select"
                  value={doc.theme.borderRadius || "md"}
                  onChange={(e) => {
                    pushDocumentChange({
                      ...doc,
                      theme: { ...doc.theme, borderRadius: e.target.value as any },
                      updatedAt: new Date().toISOString(),
                    });
                  }}
                >
                  <option value="none">Square (0px)</option>
                  <option value="sm">Small (6px)</option>
                  <option value="md">Medium (10px)</option>
                  <option value="lg">Large (16px)</option>
                  <option value="full">Pill (9999px)</option>
                </select>
              </div>
            </div>
          )}

          {/* TAB: ADVANCED */}
          {inspectorTab === "advanced" && (
            <div className="npati-builder-inspector-content">
              <span className="npati-builder-sections-title">Advanced Settings</span>

              {selectedBlock && (
                <div className="npati-builder-form-group">
                  <label className="npati-builder-form-label">Section ID (Anchor)</label>
                  <input
                    type="text"
                    className="npati-builder-input"
                    value={`#${selectedBlock.type}`}
                    readOnly
                  />
                </div>
              )}

              {activePage && doc && (
                <>
                  <div className="npati-builder-form-group">
                    <label className="npati-builder-form-label">Page Meta Title</label>
                    <input
                      type="text"
                      className="npati-builder-input"
                      value={activePage.seo?.title || ""}
                      onChange={(e) => {
                        const updatedPages = doc.pages.map((p) =>
                          p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), title: e.target.value } } : p
                        );
                        pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
                      }}
                    />
                  </div>

                  <div className="npati-builder-form-group">
                    <label className="npati-builder-form-label">Meta Description</label>
                    <textarea
                      rows={3}
                      className="npati-builder-textarea"
                      value={activePage.seo?.description || ""}
                      onChange={(e) => {
                        const updatedPages = doc.pages.map((p) =>
                          p.id === activePage.id ? { ...p, seo: { ...(p.seo || {}), description: e.target.value } } : p
                        );
                        pushDocumentChange({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
                      }}
                    />
                  </div>
                </>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setActiveDrawer("files")}
                  style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <IconFile />
                  <span>Inspect Code & Files</span>
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setActiveDrawer("history")}
                  style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <IconGrip />
                  <span>View Checkpoints</span>
                </button>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => setActiveDrawer("ai")}
                  style={{ textAlign: "left", display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <IconSparkles />
                  <span>Ask AI Assistant</span>
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ========================================================================= */}
      {/* SECONDARY DRAWERS (AI CHAT / FILES / HISTORY)                             */}
      {/* ========================================================================= */}
      {activeDrawer && (
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
      )}

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
              <div className="npati-builder-form-group">
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

              <div className="npati-builder-form-group">
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

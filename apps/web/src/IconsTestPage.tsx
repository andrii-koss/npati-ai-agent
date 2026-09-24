import React, { useState } from "react";
import { Link } from "react-router-dom";

export type IconStylePack = "line" | "solid" | "tech" | "duotone";

export interface IconOption {
  id: string;
  name: string;
  pack: IconStylePack;
  svg: (props: { size?: number }) => React.ReactElement;
}

export interface SectionIconDef {
  key: string;
  title: string;
  description: string;
  route: string;
  options: IconOption[];
}

export const SETTINGS_ICONS_CATALOG: SectionIconDef[] = [
  {
    key: "ai",
    title: "AI Providers",
    description: "Connect providers, browse models, and choose AI routing.",
    route: "/settings/ai",
    options: [
      {
        id: "ai-line",
        name: "Option A · Line AI Spark",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
            <path d="M19 4v4" />
            <path d="M21 6h-4" />
          </svg>
        ),
      },
      {
        id: "ai-solid",
        name: "Option B · Solid AI Star",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2c.4 0 .7.3.8.7l1.7 5.2c.4 1.1 1.2 2 2.3 2.3l5.2 1.7c.5.2.5.8 0 1l-5.2 1.7c-1.1.4-2 1.2-2.3 2.3l-1.7 5.2c-.2.5-.8.5-1 0l-1.7-5.2c-.4-1.1-1.2-2-2.3-2.3L2.6 13c-.5-.2-.5-.8 0-1l5.2-1.7c1.1-.4 2-1.2 2.3-2.3l1.7-5.2c.1-.5.3-.8.2-.8Z" />
          </svg>
        ),
      },
      {
        id: "ai-tech",
        name: "Option C · Microchip CPU",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="14" height="14" x="5" y="5" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
          </svg>
        ),
      },
      {
        id: "ai-duotone",
        name: "Option D · Duotone Neural Node",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a4 4 0 0 0-4 4c0 .7.2 1.4.5 2L5 12a4 4 0 0 0-1 8 4 4 0 0 0 6.8-2h2.4A4 4 0 0 0 20 20a4 4 0 0 0-1-8l-3.5-4c.3-.6.5-1.3.5-2a4 4 0 0 0-4-4Z" opacity="0.3" fill="currentColor" stroke="none" />
            <circle cx="12" cy="6" r="3" />
            <circle cx="6" cy="17" r="3" />
            <circle cx="18" cy="17" r="3" />
            <path d="m8.5 7.5 7 7M15.5 7.5l-7 7M9 17h6" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "business",
    title: "Business",
    description: "Analyze a business idea, market, goals and strategy.",
    route: "/settings/business",
    options: [
      {
        id: "biz-line",
        name: "Option A · Line Briefcase",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            <rect width="20" height="14" x="2" y="6" rx="2" />
            <path d="M2 13h20" />
          </svg>
        ),
      },
      {
        id: "biz-solid",
        name: "Option B · Solid Briefcase",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 2a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v3h20V8a2 2 0 0 0-2-2h-4V4a2 2 0 0 0-2-2h-4zm0 2h4v2h-4V4zM2 13v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7H2zm8 1h4v2h-4v-2z" />
          </svg>
        ),
      },
      {
        id: "biz-tech",
        name: "Option C · Market Trend Chart",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-5 5" />
            <path d="M19 14V9h-5" />
          </svg>
        ),
      },
      {
        id: "biz-duotone",
        name: "Option D · Duotone Enterprise",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" opacity="0.25" stroke="none" />
            <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            <rect width="20" height="14" x="2" y="6" rx="2" />
            <path d="M10 11h4" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "company",
    title: "Company",
    description: "Build your configurable AI team and agent organization.",
    route: "/settings/company",
    options: [
      {
        id: "comp-line",
        name: "Option A · Line Organization Tree",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="5" rx="1.5" />
            <rect x="3" y="15" width="6" height="5" rx="1.5" />
            <rect x="15" y="15" width="6" height="5" rx="1.5" />
            <path d="M12 8v4M6 12h12v3M6 12v3" />
          </svg>
        ),
      },
      {
        id: "comp-solid",
        name: "Option B · Solid Building / HQ",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 21h18v-2H3v2zm3-4h12V3H6v14zm2-12h3v2H8V5zm5 0h3v2h-3V5zm-5 4h3v2H8V9zm5 0h3v2h-3V9zm-5 4h3v2H8v-2zm5 0h3v2h-3v-2z" />
          </svg>
        ),
      },
      {
        id: "comp-tech",
        name: "Option C · Multi-Agent Squad",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        id: "comp-duotone",
        name: "Option D · Duotone Hierarchy Hub",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="5" r="3" fill="currentColor" opacity="0.3" stroke="none" />
            <circle cx="6" cy="18" r="3" fill="currentColor" opacity="0.3" stroke="none" />
            <circle cx="18" cy="18" r="3" fill="currentColor" opacity="0.3" stroke="none" />
            <circle cx="12" cy="5" r="3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="18" r="3" />
            <path d="M12 8v4M6 15v-3h12v3" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "capabilities",
    title: "Capability Inspector",
    description: "Audit 306 canonical capabilities, tool visibility, and risk policies.",
    route: "/settings/capabilities",
    options: [
      {
        id: "cap-line",
        name: "Option A · Line Shield Check",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        ),
      },
      {
        id: "cap-solid",
        name: "Option B · Solid Sliders",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 6h3.1a3 3 0 0 0 5.8 0H21v-2H11.9a3 3 0 0 0-5.8 0H3v2zm6-2a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm12 7h-9.1a3 3 0 0 0-5.8 0H3v2h3.1a3 3 0 0 0 5.8 0H21v-2zm-12 2a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm12 5h-3.1a3 3 0 0 0-5.8 0H3v2h9.1a3 3 0 0 0 5.8 0H21v-2zm-6 2a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
          </svg>
        ),
      },
      {
        id: "cap-tech",
        name: "Option C · Audit Crosshair",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        ),
      },
      {
        id: "cap-duotone",
        name: "Option D · Duotone Shield Key",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="currentColor" opacity="0.3" stroke="none" />
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "activity",
    title: "Activity & Run Trace",
    description: "Inspect live execution traces, step delegations, and tool decisions.",
    route: "/settings/activity",
    options: [
      {
        id: "act-line",
        name: "Option A · Line Pulse / Trace",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        ),
      },
      {
        id: "act-solid",
        name: "Option B · Solid Play Trace",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1.5.86l14-8a1 1 0 0 0 0-1.72l-14-8A1 1 0 0 0 4 3zm16 1a1 1 0 0 1 1 1v14a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1z" />
          </svg>
        ),
      },
      {
        id: "act-tech",
        name: "Option C · Terminal Prompt >_",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="3" />
            <path d="m7 8 4 4-4 4" />
            <path d="M13 16h4" />
          </svg>
        ),
      },
      {
        id: "act-duotone",
        name: "Option D · Duotone Pulse Wave",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.25" stroke="none" />
            <circle cx="12" cy="12" r="9" />
            <path d="M7 12h2l2 4 3-8 2 4h2" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "automations",
    title: "Automations",
    description: "Schedule recurring cron jobs and background agent tasks.",
    route: "/settings/automations",
    options: [
      {
        id: "auto-line",
        name: "Option A · Line Lightning Trigger",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        ),
      },
      {
        id: "auto-solid",
        name: "Option B · Solid Clock / Cron",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 11h-4v-2h2V7h2v6z" />
          </svg>
        ),
      },
      {
        id: "auto-tech",
        name: "Option C · Precision Gears",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
      },
      {
        id: "auto-duotone",
        name: "Option D · Duotone Cron Loop",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.25" stroke="none" />
            <path d="M21.5 2v6h-6M2.5 22v-6h6" />
            <path d="M20 12A8 8 0 0 0 4.93 7.07L2.5 9.5M21.5 14.5l-2.43 2.43A8 8 0 0 1 4 12" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "email",
    title: "Email / AI Inbox",
    description: "Corporate email addresses, IMAP/SMTP, and AI inbox automation.",
    route: "/settings/email",
    options: [
      {
        id: "mail-line",
        name: "Option A · Line Envelope",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="20" height="16" x="2" y="4" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>
        ),
      },
      {
        id: "mail-solid",
        name: "Option B · Solid Mail",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4.25-8 5.33-8-5.33V6l8 5.33L20 6v2.25z" />
          </svg>
        ),
      },
      {
        id: "mail-tech",
        name: "Option C · Modern At-Sign @",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
          </svg>
        ),
      },
      {
        id: "mail-duotone",
        name: "Option D · Duotone Paper Plane",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-11 11-4-1L22 2z" fill="currentColor" opacity="0.3" stroke="none" />
            <path d="m22 2-7 20-4-9-9-4 20-7z" />
            <path d="M22 2 11 13" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "goals",
    title: "Goals",
    description: "Define and track measurable business outcomes.",
    route: "/settings/goals",
    options: [
      {
        id: "goal-line",
        name: "Option A · Line Target Bullseye",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        ),
      },
      {
        id: "goal-solid",
        name: "Option B · Solid Trophy",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 4h-3V2H8v2H5a2 2 0 0 0-2 2v2a5 5 0 0 0 4.18 4.93A6 6 0 0 0 11 15.9V18H8v2h8v-2h-3v-2.1a6 6 0 0 0 3.82-2.97A5 5 0 0 0 21 8V6a2 2 0 0 0-2-2zM5 8V6h3v5.6A3 3 0 0 1 5 8zm14 0a3 3 0 0 1-3 3.6V6h3v2z" />
          </svg>
        ),
      },
      {
        id: "goal-tech",
        name: "Option C · Milestone Flag",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" x2="4" y1="22" y2="15" />
          </svg>
        ),
      },
      {
        id: "goal-duotone",
        name: "Option D · Duotone Target Center",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.25" stroke="none" />
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "content",
    title: "Content",
    description: "Plan, generate, and manage content for your audience.",
    route: "/settings/content",
    options: [
      {
        id: "cont-line",
        name: "Option A · Line Document & Pen",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" x2="8" y1="13" y2="13" />
            <line x1="16" x2="8" y1="17" y2="17" />
            <line x1="10" x2="8" y1="9" y2="9" />
          </svg>
        ),
      },
      {
        id: "cont-solid",
        name: "Option B · Solid Creative Palette",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.21-.64-1.67-.08-.1-.13-.22-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zM6.5 12c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
          </svg>
        ),
      },
      {
        id: "cont-tech",
        name: "Option C · Layout / Media Grid",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        ),
      },
      {
        id: "cont-duotone",
        name: "Option D · Duotone Stories Book",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" fill="currentColor" opacity="0.3" stroke="none" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" fill="currentColor" opacity="0.3" stroke="none" />
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "connections",
    title: "Connections",
    description: "Manage APIs, webhooks, and third-party integrations.",
    route: "/settings/connections",
    options: [
      {
        id: "conn-line",
        name: "Option A · Line Power Plug",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z" />
          </svg>
        ),
      },
      {
        id: "conn-solid",
        name: "Option B · Solid Link Chain",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
          </svg>
        ),
      },
      {
        id: "conn-tech",
        name: "Option C · Webhook Node Sockets",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
            <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
          </svg>
        ),
      },
      {
        id: "conn-duotone",
        name: "Option D · Duotone Integration Hub",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.25" stroke="none" />
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "memory",
    title: "Memory",
    description: "Manage global and company agent memory records.",
    route: "/settings/memory",
    options: [
      {
        id: "mem-line",
        name: "Option A · Line Brain",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04" />
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04" />
          </svg>
        ),
      },
      {
        id: "mem-solid",
        name: "Option B · Solid Database Stack",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 3.79 2 6v12c0 2.21 4.48 4 10 4s10-1.79 10-4V6c0-2.21-4.48-4-10-4zm0 2c4.42 0 8 1.34 8 2s-3.58 2-8 2-8-1.34-8-2 3.58-2 8-2zm8 14c0 .66-3.58 2-8 2s-8-1.34-8-2v-2.15c1.95 1.3 5.02 2.15 8 2.15s6.05-.85 8-2.15V18zm0-4c0 .66-3.58 2-8 2s-8-1.34-8-2v-2.15c1.95 1.3 5.02 2.15 8 2.15s6.05-.85 8-2.15V14z" />
          </svg>
        ),
      },
      {
        id: "mem-tech",
        name: "Option C · Circuit Memory Chip",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
          </svg>
        ),
      },
      {
        id: "mem-duotone",
        name: "Option D · Duotone Synaptic Core",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" fill="currentColor" opacity="0.25" stroke="none" />
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        ),
      },
    ],
  },
  {
    key: "skills",
    title: "Skills",
    description: "Install, build, and customize modular agent capabilities.",
    route: "/settings/skills",
    options: [
      {
        id: "sk-line",
        name: "Option A · Line Magic Wand",
        pack: "line",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 4-2 4 4-2-2-2zM9 2l1 2-2 1 1-3zM2 13l2-1-1 3-1-2zM21 21l-9-9M12 12l-2 2-7 7a1.4 1.4 0 0 0 2 2l7-7 2-2z" />
          </svg>
        ),
      },
      {
        id: "sk-solid",
        name: "Option B · Solid Puzzle Piece",
        pack: "solid",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 12h-2v-1a2 2 0 0 0-4 0v1h-2a2 2 0 0 0-2 2v2a2 2 0 0 0 0 4h2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 0-4h1a2 2 0 0 0 2-2v-2a2 2 0 0 0 0-4h-1v-2a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v1h-1a2 2 0 0 0-2 2v2h2v1a2 2 0 0 0 4 0v-1h2v3z" />
          </svg>
        ),
      },
      {
        id: "sk-tech",
        name: "Option C · Toolbox & Tools",
        pack: "tech",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        ),
      },
      {
        id: "sk-duotone",
        name: "Option D · Duotone Certified Rosette",
        pack: "duotone",
        svg: ({ size = 20 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="6" fill="currentColor" opacity="0.3" stroke="none" />
            <circle cx="12" cy="8" r="6" />
            <path d="m8.21 13.89-1.21 7.11 5-3 5 3-1.21-7.11" />
            <path d="m10 8 1.5 1.5L14 6.5" />
          </svg>
        ),
      },
    ],
  },
];

export function IconsTestPage() {
  const [selectedPack, setSelectedPack] = useState<IconStylePack>("line");
  const [customPicks, setCustomPicks] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    SETTINGS_ICONS_CATALOG.forEach((item) => {
      const first = item.options[0];
      if (first) init[item.key] = first.id;
    });
    return init;
  });
  const [copied, setCopied] = useState(false);

  const applyStylePack = (pack: IconStylePack) => {
    setSelectedPack(pack);
    const updated: Record<string, string> = {};
    SETTINGS_ICONS_CATALOG.forEach((sec) => {
      const match = sec.options.find((opt) => opt.pack === pack) ?? sec.options[0];
      if (match) updated[sec.key] = match.id;
    });
    setCustomPicks(updated);
  };

  const handlePickOption = (sectionKey: string, optionId: string) => {
    setCustomPicks((prev) => ({ ...prev, [sectionKey]: optionId }));
  };

  const copySelectionSummary = () => {
    const lines = SETTINGS_ICONS_CATALOG.map((sec) => {
      const selectedId = customPicks[sec.key];
      const opt = sec.options.find((o) => o.id === selectedId) ?? sec.options[0];
      return `• ${sec.title}: ${opt?.name ?? "Default"} (${opt?.id ?? ""})`;
    });
    const text = `NPATI Settings Icon Selection:\nPack: ${selectedPack.toUpperCase()}\n\n${lines.join("\n")}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="icons-test-page" style={{ paddingBottom: 80 }}>
      {/* Top Header */}
      <div className="page-heading settings-page-heading" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
          <div>
            <p className="eyebrow">Settings · Icon Design Studio (Тестова сторінка)</p>
            <h1 style={{ margin: "4px 0 8px 0" }}>Choose White Icons on Black Squares</h1>
            <p style={{ maxWidth: 720, color: "var(--npati-gray-600, #555)", margin: 0 }}>
              Оберіть стиль білих іконок на чорному квадратику для всіх розділів налаштувань.
              Ви можете увімкнути один зі стильових наборів (Style Packs) або налаштувати кожну іконку окремо в галереї нижче.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link to="/settings" className="button-secondary" style={{ padding: "8px 16px", textDecoration: "none" }}>
              ← Back to Settings
            </Link>
            <button type="button" className="button-primary automations-action-primary" onClick={copySelectionSummary}>
              {copied ? "✓ Copied to Clipboard!" : "📋 Copy My Selection"}
            </button>
          </div>
        </div>
      </div>

      {/* Style Pack Selector Bar */}
      <div className="icons-test-pack-bar" style={{
        background: "#ffffff",
        border: "1px solid #e5e5e5",
        borderRadius: 16,
        padding: "18px 24px",
        marginBottom: 32,
        boxShadow: "0 2px 10px rgba(0,0,0,0.03)"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <strong style={{ fontSize: 15, display: "block", color: "#111" }}>1. Fast Selection: Choose a Unified Style Pack</strong>
            <span style={{ fontSize: 13, color: "#666" }}>Клацніть один з наборів, щоб миттєво побачити всі 12 розділів у цьому стилі:</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { pack: "line" as IconStylePack, label: "Style 1: Minimal Line (2px Contour)", desc: "Feather / Lucide Style" },
              { pack: "solid" as IconStylePack, label: "Style 2: Solid Glyphs (Filled)", desc: "Bold Contrast" },
              { pack: "tech" as IconStylePack, label: "Style 3: Tech / Circuits (Geometric)", desc: "Cyber / Data Style" },
              { pack: "duotone" as IconStylePack, label: "Style 4: Duotone (White + Translucent)", desc: "Depth & Layers" },
            ].map((p) => (
              <button
                key={p.pack}
                type="button"
                className={`icon-pack-pill ${selectedPack === p.pack ? "active" : ""}`}
                onClick={() => applyStylePack(p.pack)}
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 650,
                  cursor: "pointer",
                  border: selectedPack === p.pack ? "1px solid #d83438" : "1px solid #d9d9d9",
                  background: selectedPack === p.pack ? "#d83438" : "#fbfbfb",
                  color: selectedPack === p.pack ? "#ffffff" : "#222222",
                  transition: "all 140ms ease",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live Preview on Real Settings Cards */}
      <div style={{ marginBottom: 44 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>
              2. Live Preview on /settings Grid ({SETTINGS_ICONS_CATALOG.length} Cards)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: 13, color: "#666" }}>
              Так виглядатимуть чорні квадратики з білими іконками на головній сторінці <Link to="/settings" style={{ color: "#d83438" }}>/settings</Link>:
            </p>
          </div>
          <span style={{ fontSize: 12, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", padding: "4px 10px", borderRadius: 999, fontWeight: 600 }}>
            Live Interactive Grid
          </span>
        </div>

        <div className="settings-card-grid">
          {SETTINGS_ICONS_CATALOG.map((sec) => {
            const currentOptionId = customPicks[sec.key];
            const activeOption = sec.options.find((o) => o.id === currentOptionId) ?? sec.options[0];
            if (!activeOption) return null;
            return (
              <div className="settings-ai-card" key={sec.key} style={{ cursor: "default" }}>
                <span className="provider-avatar" style={{
                  display: "grid",
                  placeItems: "center",
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  background: "#000000",
                  color: "#ffffff",
                  boxShadow: "0 3px 9px rgba(0,0,0,0.22)",
                  flexShrink: 0
                }}>
                  {activeOption.svg({ size: 19 })}
                </span>
                <span>
                  <strong>{sec.title}</strong>
                  <small>{sec.description}</small>
                  <span style={{ display: "inline-block", marginTop: 4, fontSize: 10.5, color: "#d83438", fontWeight: 700 }}>
                    {activeOption.name}
                  </span>
                </span>
                <b aria-hidden="true">&rarr;</b>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detailed Side-by-Side Comparison Gallery */}
      <div>
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>
            3. Detailed Gallery: Pick Options for Each Section
          </h2>
          <p style={{ margin: "2px 0 0 0", fontSize: 13, color: "#666" }}>
            Натисніть на будь-який квадратик, щоб застосувати його до відповідного розділу:
          </p>
        </div>

        <div style={{ display: "grid", gap: 20 }}>
          {SETTINGS_ICONS_CATALOG.map((sec) => (
            <div
              key={sec.key}
              style={{
                background: "#ffffff",
                border: "1px solid #e7e7e7",
                borderRadius: 16,
                padding: "18px 22px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{sec.title}</h3>
                  <code style={{ fontSize: 12, background: "#f3f4f6", padding: "2px 8px", borderRadius: 6, color: "#666" }}>
                    {sec.route}
                  </code>
                </div>
                <span style={{ fontSize: 12, color: "#888" }}>4 Style Variants</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
                {sec.options.map((opt) => {
                  const isSelected = customPicks[sec.key] === opt.id;
                  return (
                    <button
                      type="button"
                      key={opt.id}
                      onClick={() => handlePickOption(sec.key, opt.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: isSelected ? "2px solid #d83438" : "1px solid #e2e8f0",
                        background: isSelected ? "#fff5f5" : "#fcfcfc",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "all 140ms ease",
                      }}
                    >
                      {/* Black square with white icon */}
                      <span
                        style={{
                          width: 42,
                          height: 42,
                          borderRadius: 11,
                          background: "#000000",
                          color: "#ffffff",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          boxShadow: "0 3px 8px rgba(0,0,0,0.25)",
                        }}
                      >
                        {opt.svg({ size: 21 })}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ display: "block", fontSize: 13, color: isSelected ? "#b91c1c" : "#111" }}>
                          {opt.name}
                        </strong>
                        <span style={{ fontSize: 11, color: isSelected ? "#ef4444" : "#64748b" }}>
                          {isSelected ? "● Selected" : "Click to choose"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import React, { useId } from "react";

export type PreviewPlaceholderVariant = "website" | "mobile" | "game" | "other";
export type PreviewPlaceholderStatus = "empty" | "coming_soon" | "loading" | "error";

export interface ProjectPreviewPlaceholderProps {
  kind?: string | null;
  type?: string | null;
  framework?: string | null;
  variant?: PreviewPlaceholderVariant;
  status?: PreviewPlaceholderStatus;
  language?: string;
  errorMessage?: string;
}

export function resolvePreviewVariant(input: {
  variant?: PreviewPlaceholderVariant;
  kind?: string | null;
  type?: string | null;
  framework?: string | null;
}): PreviewPlaceholderVariant {
  if (input.variant) return input.variant;
  const kind = (input.kind ?? "").toLowerCase().trim();
  const type = (input.type ?? "").toLowerCase().trim();
  const fw = (input.framework ?? "").toLowerCase().trim();

  if (kind === "mobile_app" || type === "mobile_app" || /expo|react\s*native|flutter|ios|android|mobile/.test(fw)) {
    return "mobile";
  }
  if (kind === "game" || type === "game" || /game|canvas|phaser|pixi|three/.test(fw)) {
    return "game";
  }
  if (kind === "api" || kind === "other" || type === "api" || type === "other") {
    return "other";
  }
  if (kind === "website" || kind === "web_app" || type === "website" || type === "web_app" || type === "landing_page") {
    return "website";
  }
  if (/next|vite|react|astro|html|css|vue|svelte|nuxt|angular|tailwind/.test(fw)) {
    return "website";
  }
  return "other";
}

function getPlaceholderCopy(
  variant: PreviewPlaceholderVariant,
  status: PreviewPlaceholderStatus,
  language: string,
  errorMessage?: string,
): { title: string; subtitle: string } {
  const uk = language === "uk";

  if (status === "loading") {
    return {
      title: uk ? "Створення превʼю..." : "Generating preview...",
      subtitle: uk
        ? "Формуємо справжній знімок вашого проєкту."
        : "Capturing a live snapshot of your project.",
    };
  }

  if (status === "error") {
    return {
      title: uk ? "Превʼю недоступне" : "Preview unavailable",
      subtitle:
        errorMessage?.trim() ||
        (uk
          ? "Не вдалося створити превʼю. Спробуйте оновити знімок."
          : "Could not generate project preview. Try refreshing the snapshot."),
    };
  }

  if (status === "coming_soon" || variant === "mobile") {
    return {
      title: uk ? "Превʼю незабаром зʼявиться" : "Preview coming soon",
      subtitle: uk
        ? "Тут зʼявиться превʼю цього проєкту."
        : "This project's preview will appear here.",
    };
  }

  return {
    title: uk ? "Превʼю ще немає" : "No preview yet",
    subtitle: uk
      ? "Превʼю буде доступне після налаштування проєкту."
      : "A preview will be available after the project is set up.",
  };
}

export const ProjectPreviewPlaceholder = React.memo(function ProjectPreviewPlaceholder({
  kind,
  type,
  framework,
  variant: explicitVariant,
  status = "empty",
  language = "en",
  errorMessage,
}: ProjectPreviewPlaceholderProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const variant = resolvePreviewVariant({ variant: explicitVariant, kind, type, framework });
  const effectiveStatus: PreviewPlaceholderStatus =
    status === "empty" && variant === "mobile" ? "coming_soon" : status;
  const { title, subtitle } = getPlaceholderCopy(variant, effectiveStatus, language, errorMessage);

  const isCoolTheme = variant === "mobile" || variant === "game";
  const toneClass = isCoolTheme ? "placeholder-tone-cool" : "placeholder-tone-warm";
  const statusClass = `placeholder-status-${effectiveStatus}`;

  const windowShadowId = `pp-win-shadow-${uid}`;
  const sideShadowId = `pp-side-shadow-${uid}`;
  const cardGlowId = `pp-glow-${uid}`;

  return (
    <div
      className={`website-card-placeholder project-preview-placeholder ${toneClass} ${statusClass} placeholder-variant-${variant}`}
      data-placeholder="true"
      data-project-variant={variant}
      data-preview-state={effectiveStatus}
    >
      {/* Subtle grid overlay */}
      <div className="project-preview-placeholder-grid" aria-hidden="true" />

      {/* Decorative SVG Mockup Illustration */}
      <div className="project-preview-placeholder-art" aria-hidden="true">
        <svg
          className="project-preview-placeholder-svg"
          viewBox="0 0 400 184"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id={windowShadowId} x="40" y="0" width="320" height="184" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#1e293b" floodOpacity="0.075" />
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#1e293b" floodOpacity="0.035" />
            </filter>
            <filter id={sideShadowId} x="10" y="-8" width="380" height="196" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#1e293b" floodOpacity="0.06" />
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#1e293b" floodOpacity="0.03" />
            </filter>
            <linearGradient id={cardGlowId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.82" />
              <stop offset="100%" stopColor="#f8fafc" stopOpacity="0.72" />
            </linearGradient>
          </defs>

          {/* Subtle geometric technical lines & dashed rings behind window */}
          <g className="pp-tech-accents" opacity="0.65">
            {isCoolTheme ? (
              <>
                <circle cx="336" cy="118" r="25" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1.1" strokeDasharray="3 3" />
                <circle cx="62" cy="54" r="18" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1.1" strokeDasharray="3 3" />
                <line x1="36" y1="78" x2="72" y2="42" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1" />
                <line x1="326" y1="82" x2="362" y2="118" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1" strokeDasharray="2 3" />
              </>
            ) : (
              <>
                <circle cx="66" cy="134" r="22" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1.1" strokeDasharray="3 3" />
                <circle cx="332" cy="42" r="19" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1.1" strokeDasharray="3 3" />
                <line x1="308" y1="10" x2="360" y2="62" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1" />
                <line x1="42" y1="118" x2="76" y2="152" stroke="var(--pp-accent-stroke, #cbd5e1)" strokeWidth="1" strokeDasharray="2 3" />
              </>
            )}
          </g>

          {/* TWO Prominent Side Floating Squares with Shadows (Left & Right of Central Window) */}
          {isCoolTheme ? (
            <g className="pp-floating-shapes" filter={`url(#${sideShadowId})`}>
              {/* Top-Right floating rounded square */}
              <rect
                x="280"
                y="4"
                width="78"
                height="74"
                rx="16"
                fill="var(--pp-blob-primary, rgba(203, 215, 252, 0.65))"
                stroke="rgba(255, 255, 255, 0.6)"
                strokeWidth="1"
              />
              {/* Bottom-Left floating rounded square */}
              <rect
                x="42"
                y="98"
                width="74"
                height="68"
                rx="15"
                fill="var(--pp-blob-secondary, rgba(208, 220, 253, 0.68))"
                stroke="rgba(255, 255, 255, 0.6)"
                strokeWidth="1"
              />
            </g>
          ) : (
            <g className="pp-floating-shapes" filter={`url(#${sideShadowId})`}>
              {/* Middle-Left floating rounded square */}
              <rect
                x="40"
                y="46"
                width="74"
                height="72"
                rx="16"
                fill="var(--pp-blob-primary, rgba(253, 203, 210, 0.62))"
                stroke="rgba(255, 255, 255, 0.6)"
                strokeWidth="1"
              />
              {/* Bottom-Right floating rounded square/circle */}
              <rect
                x="284"
                y="92"
                width="74"
                height="72"
                rx="24"
                fill="var(--pp-blob-secondary, rgba(253, 206, 215, 0.64))"
                stroke="rgba(255, 255, 255, 0.6)"
                strokeWidth="1"
              />
            </g>
          )}

          {/* Large Central Translucent Glassmorphic Window */}
          <g filter={`url(#${windowShadowId})`}>
            <rect
              x="68"
              y="14"
              width="264"
              height="154"
              rx="14"
              fill={`url(#${cardGlowId})`}
              className="pp-window-surface"
            />
            <rect
              x="68.6"
              y="14.6"
              width="262.8"
              height="152.8"
              rx="13.4"
              stroke="var(--pp-window-border, rgba(226, 232, 240, 0.95))"
              strokeWidth="1.2"
            />
          </g>

          {/* Window Top Bar Traffic Lights */}
          <circle cx="88" cy="29" r="3.6" fill="#f87171" opacity="0.88" />
          <circle cx="99.5" cy="29" r="3.6" fill={isCoolTheme ? "#60a5fa" : "#93c5fd"} opacity="0.88" />
          <circle cx="111" cy="29" r="3.6" fill="#34d399" opacity="0.88" />

          {/* Left Sidebar Skeleton Items */}
          <g className="pp-sidebar-items" opacity="0.88">
            <circle cx="88" cy="54" r="3.6" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            <rect x="97" y="50.5" width="33" height="7" rx="3.5" fill="var(--pp-skeleton-base, #dce4f0)" />

            <circle cx="88" cy="72" r="3.6" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            <rect x="97" y="68.5" width="33" height="7" rx="3.5" fill="var(--pp-skeleton-base, #dce4f0)" />

            <circle cx="88" cy="90" r="3.6" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            <rect x="97" y="86.5" width="33" height="7" rx="3.5" fill="var(--pp-skeleton-base, #dce4f0)" />

            <circle cx="88" cy="108" r="3.6" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            <rect x="97" y="104.5" width="33" height="7" rx="3.5" fill="var(--pp-skeleton-base, #dce4f0)" />

            <circle cx="88" cy="126" r="3.6" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            <rect x="97" y="122.5" width="28" height="7" rx="3.5" fill="var(--pp-skeleton-base, #dce4f0)" />
          </g>

          {/* Inner Content Surface Based on Project Variant */}
          {variant === "website" && (
            <g className="pp-variant-website">
              {/* Main inner browser viewport card */}
              <rect x="142" y="38" width="176" height="116" rx="10" fill="var(--pp-inner-card, #ffffff)" fillOpacity="0.9" />
              {/* Avatar / Brand Circle + Hero Text Bars (matches right card in reference) */}
              <circle cx="174" cy="67" r="16" fill="var(--pp-skeleton-base, #dce4f0)" />
              <rect x="200" y="57" width="90" height="7.5" rx="3.75" fill="var(--pp-skeleton-strong, #cbd5e1)" />
              <rect x="200" y="71" width="62" height="6.5" rx="3.25" fill="var(--pp-skeleton-base, #dce4f0)" />
              {/* Two bottom content cards */}
              <rect x="156" y="95" width="71" height="46" rx="7" fill="var(--pp-skeleton-soft, #e8eef7)" />
              <rect x="235" y="95" width="71" height="46" rx="7" fill="var(--pp-skeleton-soft, #e8eef7)" />
            </g>
          )}

          {variant === "mobile" && (
            <g className="pp-variant-mobile">
              {/* Main inner surface with large mountain hero + 2 bottom cards (matches left card in reference) */}
              <rect x="142" y="38" width="176" height="116" rx="10" fill="var(--pp-inner-card, #ffffff)" fillOpacity="0.9" />
              {/* Hero media screen with mountain landscape silhouette */}
              <rect x="154" y="48" width="152" height="60" rx="8" fill="var(--pp-skeleton-soft, #e4ecf8)" />
              {/* Mountain / landscape silhouette inside hero */}
              <path
                d="M194 98L218 71L235 89L248 76L269 98H194Z"
                fill="var(--pp-skeleton-strong, #c5d1e6)"
                opacity="0.92"
              />
              <circle cx="253" cy="64" r="5" fill="var(--pp-skeleton-strong, #c5d1e6)" opacity="0.82" />
              {/* Two bottom app cards */}
              <rect x="154" y="115" width="72" height="29" rx="6" fill="var(--pp-skeleton-soft, #e4ecf8)" />
              <rect x="234" y="115" width="72" height="29" rx="6" fill="var(--pp-skeleton-soft, #e4ecf8)" />
            </g>
          )}

          {variant === "game" && (
            <g className="pp-variant-game">
              {/* Game stage screen */}
              <rect x="142" y="38" width="176" height="116" rx="10" fill="var(--pp-inner-card, #ffffff)" fillOpacity="0.9" />
              {/* Game canvas viewport */}
              <rect x="154" y="48" width="152" height="60" rx="8" fill="var(--pp-skeleton-soft, #e4ecf8)" />
              {/* Game HUD: score pill + lives */}
              <rect x="164" y="56" width="40" height="5.5" rx="2.75" fill="var(--pp-skeleton-strong, #cbd5e1)" />
              <circle cx="290" cy="58.5" r="3.3" fill="#fbbf24" opacity="0.88" />
              <circle cx="280" cy="58.5" r="3.3" fill="#f87171" opacity="0.78" />
              {/* Game terrain / arcade elements */}
              <path
                d="M190 98L214 72L232 90L247 76L269 98H190Z"
                fill="var(--pp-skeleton-strong, #c5d1e6)"
                opacity="0.88"
              />
              {/* Gamepad / Controls bar below stage */}
              <rect x="154" y="115" width="72" height="29" rx="6" fill="var(--pp-skeleton-soft, #e4ecf8)" />
              <path d="M185 129.5H195M190 124.5V134.5" stroke="var(--pp-skeleton-strong, #94a3b8)" strokeWidth="2.2" strokeLinecap="round" />
              <rect x="234" y="115" width="72" height="29" rx="6" fill="var(--pp-skeleton-soft, #e4ecf8)" />
              <circle cx="264" cy="131" r="4" fill="var(--pp-skeleton-strong, #cbd5e1)" />
              <circle cx="277" cy="127" r="4" fill="var(--pp-skeleton-strong, #cbd5e1)" />
            </g>
          )}

          {variant === "other" && (
            <g className="pp-variant-other">
              {/* Universal app / API layout */}
              <rect x="142" y="38" width="176" height="116" rx="10" fill="var(--pp-inner-card, #ffffff)" fillOpacity="0.9" />
              <rect x="155" y="49" width="150" height="44" rx="7" fill="var(--pp-skeleton-soft, #e8eef7)" />
              <circle cx="176" cy="71" r="10.5" fill="var(--pp-skeleton-strong, #cbd5e1)" />
              <rect x="195" y="64" width="80" height="6.5" rx="3.25" fill="var(--pp-skeleton-strong, #cbd5e1)" />
              <rect x="195" y="75" width="54" height="5.5" rx="2.75" fill="var(--pp-skeleton-base, #dce4f0)" />
              <rect x="155" y="101" width="71" height="41" rx="6.5" fill="var(--pp-skeleton-soft, #e8eef7)" />
              <rect x="234" y="101" width="71" height="41" rx="6.5" fill="var(--pp-skeleton-soft, #e8eef7)" />
            </g>
          )}

          {/* Status overlay badge for error state */}
          {effectiveStatus === "error" && (
            <g className="pp-status-badge-error">
              <circle cx="200" cy="91" r="17" fill="#fef2f2" />
              <circle cx="200" cy="91" r="16" stroke="#fecaca" strokeWidth="1.2" />
              <path d="M200 83V92" stroke="#ef4444" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="200" cy="96.5" r="1.4" fill="#ef4444" />
            </g>
          )}
        </svg>
        {effectiveStatus === "loading" && (
          <div className="project-preview-spinner-overlay" aria-hidden="true">
            <div className="project-preview-spinner-badge">
              <span className="company-initial-spinner project-preview-red-spinner" />
            </div>
          </div>
        )}
      </div>

      {/* Bottom Centered Text Copy */}
      <div className="project-preview-placeholder-copy">
        <p className="project-preview-placeholder-title">{title}</p>
        <p className="project-preview-placeholder-subtitle">{subtitle}</p>
      </div>
    </div>
  );
});

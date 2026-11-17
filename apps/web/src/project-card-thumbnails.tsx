export function WebsiteSvgThumbnail() {
    return (<svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="webGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#C4B5FD"/>
          <stop offset="50%" stopColor="#A5B4FC"/>
          <stop offset="100%" stopColor="#93C5FD"/>
        </linearGradient>
      </defs>
      {/* Browser top bar */}
      <rect x="0" y="0" width="96" height="12" fill="#FFFFFF"/>
      <line x1="0" y1="12" x2="96" y2="12" stroke="rgba(0,0,0,0.06)" strokeWidth="1"/>
      {/* Window dots */}
      <circle cx="8" cy="6" r="1.75" fill="#FF5F56"/>
      <circle cx="14" cy="6" r="1.75" fill="#FFBD2E"/>
      <circle cx="20" cy="6" r="1.75" fill="#27C93F"/>
      {/* Canvas gradient */}
      <rect x="0" y="12" width="96" height="48" fill="url(#webGrad)"/>
      {/* Soft central bar */}
      <rect x="38" y="19" width="20" height="2.5" rx="1.25" fill="#FFFFFF" fillOpacity="0.8"/>
      {/* Bottom UI card */}
      <rect x="12" y="28" width="64" height="26" rx="4" fill="#FFFFFF" fillOpacity="0.95"/>
      <rect x="16" y="34" width="24" height="2" rx="1" fill="#CBD5E1"/>
      <rect x="16" y="39" width="48" height="2" rx="1" fill="#E2E8F0"/>
      <rect x="16" y="44" width="36" height="2" rx="1" fill="#E2E8F0"/>
    </svg>);
}
export function MobileSvgThumbnail() {
    return (<svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="mobGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366F1"/>
          <stop offset="60%" stopColor="#8B5CF6"/>
          <stop offset="100%" stopColor="#EC4899"/>
        </linearGradient>
      </defs>
      {/* Backdrop */}
      <rect width="96" height="60" fill="#F1F5F9"/>
      {/* Phone container */}
      <rect x="29" y="3" width="38" height="54" rx="7" fill="#0F172A"/>
      {/* Phone screen */}
      <rect x="31" y="5" width="34" height="50" rx="5" fill="url(#mobGrad)"/>
      {/* Dynamic island / notch */}
      <rect x="43" y="7" width="10" height="2" rx="1" fill="#0F172A"/>
      {/* Header wireframe */}
      <rect x="35" y="14" width="26" height="3" rx="1.5" fill="#FFFFFF" fillOpacity="0.85"/>
      {/* Two cards */}
      <rect x="35" y="21" width="11" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9"/>
      <rect x="50" y="21" width="11" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9"/>
      {/* Bottom list card */}
      <rect x="35" y="36" width="26" height="11" rx="2.5" fill="#FFFFFF" fillOpacity="0.9"/>
      <rect x="38" y="39" width="14" height="2" rx="1" fill="#CBD5E1"/>
      <rect x="38" y="42" width="20" height="1.5" rx="0.75" fill="#E2E8F0"/>
    </svg>);
}
export function GameSvgThumbnail() {
    return (<svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="gameGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1E1B4B"/>
          <stop offset="50%" stopColor="#312E81"/>
          <stop offset="100%" stopColor="#4C1D95"/>
        </linearGradient>
      </defs>
      {/* Top bar */}
      <rect width="96" height="12" fill="#0F172A"/>
      <circle cx="8" cy="6" r="2" fill="#EF4444"/>
      <circle cx="15" cy="6" r="2" fill="#F59E0B"/>
      <circle cx="22" cy="6" r="2" fill="#10B981"/>
      {/* Game canvas */}
      <rect y="12" width="96" height="48" fill="url(#gameGrad)"/>
      {/* Retro stars / particles */}
      <circle cx="20" cy="22" r="1" fill="#FFFFFF" fillOpacity="0.6"/>
      <circle cx="78" cy="24" r="1.5" fill="#FDE047" fillOpacity="0.8"/>
      <circle cx="85" cy="45" r="1" fill="#FFFFFF" fillOpacity="0.5"/>
      <circle cx="16" cy="48" r="1" fill="#38BDF8" fillOpacity="0.7"/>
      {/* Controller D-pad */}
      <rect x="22" y="32" width="4" height="14" rx="1" fill="#F43F5E"/>
      <rect x="17" y="37" width="14" height="4" rx="1" fill="#F43F5E"/>
      {/* Center canvas hero / pixel craft */}
      <rect x="42" y="26" width="12" height="12" rx="2" fill="#38BDF8"/>
      <rect x="45" y="29" width="6" height="6" rx="1" fill="#FFFFFF"/>
      {/* Action buttons */}
      <circle cx="70" cy="42" r="3" fill="#10B981"/>
      <circle cx="78" cy="35" r="3" fill="#F59E0B"/>
    </svg>);
}
export function OtherSvgThumbnail() {
    return (<svg className="chat-preview-card-svg" viewBox="0 0 96 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="codeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0F172A"/>
          <stop offset="100%" stopColor="#1E293B"/>
        </linearGradient>
      </defs>
      {/* Top bar */}
      <rect width="96" height="12" fill="#1E293B"/>
      <line x1="0" y1="12" x2="96" y2="12" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
      <circle cx="8" cy="6" r="2" fill="#EF4444"/>
      <circle cx="15" cy="6" r="2" fill="#F59E0B"/>
      <circle cx="22" cy="6" r="2" fill="#10B981"/>
      {/* Terminal canvas */}
      <rect y="12" width="96" height="48" fill="url(#codeGrad)"/>
      {/* Code prompt */}
      <text x="12" y="26" fill="#22C55E" fontSize="9" fontFamily="monospace" fontWeight="bold">&gt;</text>
      <rect x="22" y="20" width="30" height="2" rx="1" fill="#38BDF8"/>
      {/* Syntax lines */}
      <rect x="12" y="31" width="46" height="2" rx="1" fill="#94A3B8"/>
      <rect x="18" y="37" width="54" height="2" rx="1" fill="#CBD5E1" fillOpacity="0.8"/>
      <rect x="24" y="43" width="32" height="2" rx="1" fill="#818CF8"/>
      <rect x="12" y="49" width="20" height="2" rx="1" fill="#F43F5E"/>
    </svg>);
}

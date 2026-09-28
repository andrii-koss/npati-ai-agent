// Authentic brand vector icons for messaging integrations.
// Sized and styled to match the AI Provider Marketplace (.provider-avatar) aesthetic.

const TELEGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs>
    <linearGradient id="tg-grad" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#2AABEE"/>
      <stop offset="100%" stop-color="#229ED9"/>
    </linearGradient>
  </defs>
  <circle cx="24" cy="24" r="24" fill="url(#tg-grad)"/>
  <path d="M10.8 23.36l23.76-9.16c1.1-.4 2.06.26 1.7 1.94l-4.04 19.04c-.3 1.36-1.1 1.68-2.24 1.04l-6.16-4.54-2.98 2.86c-.32.32-.6.6-1.24.6l.44-6.3 11.46-10.36c.5-.44-.1-.7-.78-.24l-14.16 8.92-6.1-1.9c-1.32-.42-1.36-1.32.3-1.98z" fill="#ffffff"/>
</svg>`;

const DISCORD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <circle cx="24" cy="24" r="24" fill="#5865F2"/>
  <g transform="translate(24, 24) scale(1.35) translate(-12, -12)">
    <path fill="#ffffff" d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.16 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"/>
  </g>
</svg>`;

const SLACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path d="M10.1 29.5a4.6 4.6 0 1 1-4.6-4.6h4.6v4.6zm2.3 0a4.6 4.6 0 0 1 9.2 0v11.4a4.6 4.6 0 1 1-9.2 0V29.5z" fill="#E01E5A"/>
  <path d="M18.5 10.1a4.6 4.6 0 1 1-4.6-4.6v4.6h4.6zm0 2.3a4.6 4.6 0 0 1 0 9.2H7.1a4.6 4.6 0 1 1 0-9.2h11.4z" fill="#36C5F0"/>
  <path d="M37.9 18.5a4.6 4.6 0 1 1 4.6 4.6h-4.6v-4.6zm-2.3 0a4.6 4.6 0 0 1-9.2 0V7.1a4.6 4.6 0 1 1 9.2 0v11.4z" fill="#2EB67D"/>
  <path d="M29.5 37.9a4.6 4.6 0 1 1 4.6 4.6v-4.6h-4.6zm0-2.3a4.6 4.6 0 0 1 0-9.2h11.4a4.6 4.6 0 1 1 0 9.2H29.5z" fill="#ECB22E"/>
</svg>`;

const WHATSAPP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <circle cx="24" cy="24" r="24" fill="#25D366"/>
  <path fill="#ffffff" fill-rule="evenodd" d="M24 10c-7.73 0-14 6.27-14 14 0 2.57.7 5.06 2.02 7.23L10 38l7.02-1.97A13.9 13.9 0 0 0 24 38c7.73 0 14-6.27 14-14s-6.27-14-14-14zm7.98 19.82c-.34.95-1.98 1.83-2.73 1.95-.7.12-1.57.17-2.54-.15-.6-.19-1.37-.45-2.37-.88-4.2-1.82-6.93-6.08-7.14-6.36-.21-.28-1.72-2.28-1.72-4.36 0-2.07 1.09-3.09 1.48-3.52.38-.42.84-.53 1.12-.53.28 0 .56 0 .8.02.26.01.6.09.87.73.34.82 1.17 2.85 1.27 3.06.1.21.17.46.03.74-.14.28-.21.46-.42.7-.21.25-.44.55-.63.74-.21.21-.43.44-.19.85.25.42 1.1 1.81 2.36 2.93 1.62 1.44 2.98 1.89 3.4 2.1.42.21.67.18.92-.11.25-.28 1.09-1.27 1.38-1.7.29-.42.59-.35.99-.21.4.14 2.54 1.2 2.98 1.42.44.21.73.32.84.5.11.19.11 1.08-.23 2.03z"/>
</svg>`;

const EMAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs>
    <linearGradient id="em-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="100%" stop-color="#2563EB"/>
    </linearGradient>
  </defs>
  <circle cx="24" cy="24" r="24" fill="url(#em-grad)"/>
  <path d="M12 17.2c0-1.77 1.43-3.2 3.2-3.2h17.6c1.77 0 3.2 1.43 3.2 3.2v1.2l-12 8-12-8v-1.2z" fill="#ffffff"/>
  <path d="M12 21.6v9.2c0 1.77 1.43 3.2 3.2 3.2h17.6c1.77 0 3.2-1.43 3.2-3.2v-9.2l-11.12 7.41a1.6 1.6 0 0 1-1.76 0L12 21.6z" fill="#ffffff"/>
</svg>`;

const toDataUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;

export const CHANNEL_ICONS: Record<string, string> = {
  telegram: toDataUri(TELEGRAM_SVG),
  discord: toDataUri(DISCORD_SVG),
  slack: toDataUri(SLACK_SVG),
  whatsapp: toDataUri(WHATSAPP_SVG),
  email: toDataUri(EMAIL_SVG),
};

export function getChannelIcon(channelId: string): string | undefined {
  return CHANNEL_ICONS[channelId.trim().toLowerCase()];
}

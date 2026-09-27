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
  <path fill="#ffffff" d="M33.4 14.6c-2.3-1.1-4.7-1.8-7.3-2.1-.3.5-.7 1.3-1 1.9-2.7-.4-5.4-.4-8.1 0-.3-.6-.7-1.4-1-1.9-2.6.3-5 1-7.3 2.1-.1 0-.1 0-.2.1-4.6 6.9-5.9 13.6-5.3 20.3 0 0 .1.1.1.1 3 2.2 6 3.6 8.9 4.5.1 0 .1 0 .2-.1.7-.9 1.3-1.9 1.8-3 0-.1 0-.1-.1-.2-1-.4-1.9-.8-2.8-1.3-.1 0-.1-.1 0-.2.2-.1.4-.3.6-.4 0 0 .1 0 .1 0 5.8 2.7 12.1 2.7 17.8 0 .1 0 .1 0 .1 0 .2.1.4.3.6.4.1.1.1.2 0 .2-.9.5-1.8.9-2.8 1.3-.1 0-.1.1-.1.2.5 1 1.1 2 1.8 3 .1 0 .1.1.2.1 2.9-.9 5.9-2.3 8.9-4.5.1 0 .1-.1.1-.1.7-7.7-1.2-14.4-5.3-20.3 0 0-.1-.1-.2-.1zM18.8 29.5c-1.7 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.2 1.6 3.2 3.6-1.4 3.6-3.2 3.6zm10.4 0c-1.7 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.2 1.6 3.2 3.6-1.4 3.6-3.2 3.6z"/>
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
      <stop offset="100%" stop-color="#3730A3"/>
    </linearGradient>
  </defs>
  <circle cx="24" cy="24" r="24" fill="url(#em-grad)"/>
  <path fill="#ffffff" d="M12 16c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h24c1.1 0 2-.9 2-2V18c0-1.1-.9-2-2-2H12zm0 2.8l12 7.5 12-7.5V32H12V18.8zm12 5.1L13.6 18h20.8L24 23.9z"/>
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

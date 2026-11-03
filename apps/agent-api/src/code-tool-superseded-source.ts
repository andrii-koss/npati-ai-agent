/**
 * Bundlers look for ".jsx" and ".js" before ".tsx" and ".ts", so a scaffold's App.jsx silently wins over a new App.tsx
 * and the page stays empty. Deleting needs a person's approval, which an automatic run cannot get, so a new TypeScript
 * source replaces its JavaScript twin in the same step; the turn's checkpoint can restore it.
 */
export function supersededSources(path: string): string[] {
  if (/\.d\.ts$|\.(?:test|spec|config|stories)\.tsx?$/.test(path)) return [];
  const match = /^(.*)\.tsx?$/.exec(path);
  return match ? [`${match[1]}.jsx`, `${match[1]}.js`] : [];
}

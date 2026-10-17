/** Binary/image sniffing: NUL bytes plus the magic numbers that matter for source repositories. */
export function detectFileKind(content: string): { binary: boolean; image: boolean; mimeGuess: string | null } {
  const head = content.slice(0, 16);
  const magic: Array<{ test: (value: string) => boolean; mime: string; image: boolean }> = [
    { test: (value) => value.startsWith("\u0089PNG"), mime: "image/png", image: true },
    { test: (value) => value.startsWith("\u00ff\u00d8\u00ff"), mime: "image/jpeg", image: true },
    { test: (value) => value.startsWith("GIF8"), mime: "image/gif", image: true },
    { test: (value) => value.startsWith("RIFF") && value.slice(8, 12) === "WEBP", mime: "image/webp", image: true },
    { test: (value) => value.startsWith("%PDF"), mime: "application/pdf", image: false },
    { test: (value) => value.startsWith("PK\u0003\u0004"), mime: "application/zip", image: false },
    { test: (value) => value.startsWith("\u001f\u008b"), mime: "application/gzip", image: false },
    { test: (value) => value.startsWith("\u007fELF"), mime: "application/x-elf", image: false },
  ];
  const hit = magic.find((entry) => entry.test(head));
  const hasNullByte = content.includes("\u0000");
  if (hit) return { binary: true, image: hit.image, mimeGuess: hit.mime };
  if (hasNullByte) return { binary: true, image: false, mimeGuess: null };
  return { binary: false, image: false, mimeGuess: null };
}


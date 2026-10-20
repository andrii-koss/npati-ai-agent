/** Bounded repository data to avoid rediscovering stylesheet locations on every chat edit. */
export async function buildWebsiteStyleContext(files: readonly { path: string }[], readFile: (path: string) => Promise<string>): Promise<string | null> {
  const stylesheets = files.filter(file => /\.css$/i.test(file.path)).slice(0, 24).map(file => file.path);
  if (!stylesheets.length) return null;
  const entries = files.filter(file => /(?:^|\/)(?:layout|_app|App|main)\.[jt]sx?$/.test(file.path)).slice(0, 4);
  const results = await Promise.allSettled(entries.map(async file => {
    const source = await readFile(file.path);
    const imports = [...source.matchAll(/^\s*import\b[^\r\n]*?['"][^'"\r\n]+\.css['"]/gm)].map(match => match[0].trim().slice(0, 300));
    return { entry: file.path, imports: imports.slice(0, 16) };
  }));
  return "Stylesheet locations and import order (repository data):\n" + JSON.stringify({ stylesheets, entries: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []) }).slice(0, 6000);
}

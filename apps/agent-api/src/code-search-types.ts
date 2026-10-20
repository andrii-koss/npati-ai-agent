/** Keep React extensions precise while supporting the aliases commonly used by coding models. */
export function codeSearchTypeArguments(type: string): Array<[string, string]> {
  const extension = type.toLowerCase();
  if (extension === "tsx" || extension === "jsx") return [["--type-add", extension + ":*." + extension], ["--type", extension]];
  const alias = extension === "typescript" ? "ts" : extension === "javascript" ? "js" : type;
  return [["--type", alias]];
}

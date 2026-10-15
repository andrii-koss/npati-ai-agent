import React from "react";
import type { Toolchain } from "./types";

export function ToolchainCell({
  toolchain,
  isUk,
}: {
  toolchain: Toolchain | null | undefined;
  isUk: boolean;
}) {
  if (!toolchain) return <span className="ds-muted">{isUk ? "не визначено" : "not detected"}</span>;
  const languages = toolchain.languages ?? [];
  const managers = toolchain.packageManagers ?? [];
  const commands = toolchain.verifyCommands ?? {};
  const title = Object.entries(commands)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return (
    <div className="code-toolchain" title={title || undefined}>
      {languages.length === 0 && managers.length === 0 && <span className="ds-muted">—</span>}
      {languages.map((language) => (
        <span className="data-studio-badge" key={`lang-${language}`}>
          {language}
        </span>
      ))}
      {managers.map((manager) => (
        <span className="data-studio-badge" key={`pm-${manager}`}>
          {manager}
        </span>
      ))}
      {toolchain.source === "manual" && (
        <span className="data-studio-badge">{isUk ? "вручну" : "manual"}</span>
      )}
    </div>
  );
}

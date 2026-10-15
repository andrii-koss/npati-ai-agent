import React from "react";

interface ProjectImportPanelProps {
  language: string;
  filesLength: number;
  hasProject: boolean;
  importUrl: string;
  setImportUrl: (v: string) => void;
  importBranch: string;
  setImportBranch: (v: string) => void;
  importCredentialId: string;
  setImportCredentialId: (v: string) => void;
  handleRepositoryImport: (e: React.FormEvent) => void;
  importing: boolean;
  importFile: File | null;
  setImportFile: (f: File | null) => void;
  handleZipImport: () => void;
}

export function ProjectImportPanel({
  language,
  filesLength,
  hasProject,
  importUrl,
  setImportUrl,
  importBranch,
  setImportBranch,
  importCredentialId,
  setImportCredentialId,
  handleRepositoryImport,
  importing,
  importFile,
  setImportFile,
  handleZipImport,
}: ProjectImportPanelProps) {
  if (!hasProject || filesLength > 0) return null;

  return (
    <section className="project-import-panel" aria-label="Import project">
      <h2>{language === "uk" ? "Імпорт проєкту" : "Import project"}</h2>
      <p>
        {language === "uk"
          ? "Підключіть GitHub репозиторій або завантажте ZIP. NPATI перевірить файли, встановить залежності в sandbox і запустить Preview."
          : "Connect a GitHub repository or upload a ZIP. NPATI inspects files, installs dependencies in the sandbox, and starts Preview."}
      </p>
      <form className="project-import-form" onSubmit={handleRepositoryImport}>
        <input
          type="url"
          value={importUrl}
          onChange={(event) => setImportUrl(event.target.value)}
          placeholder="https://github.com/owner/repository"
          aria-label="GitHub repository URL"
          required
        />
        <input
          type="text"
          value={importBranch}
          onChange={(event) => setImportBranch(event.target.value)}
          placeholder="main"
          aria-label="Git branch"
        />
        <input
          type="text"
          value={importCredentialId}
          onChange={(event) => setImportCredentialId(event.target.value)}
          placeholder={
            language === "uk"
              ? "ID ключа в Company vault (для приватного репозиторію)"
              : "Company vault credential ID (private repository)"
          }
          aria-label="Company vault credential ID"
        />
        <button className="button-primary" type="submit" disabled={importing}>
          {importing
            ? "Importing…"
            : language === "uk"
            ? "Імпортувати GitHub"
            : "Import GitHub"}
        </button>
      </form>
      <div className="project-import-zip">
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
          aria-label="Project ZIP file"
        />
        <button
          className="button-secondary"
          type="button"
          disabled={!importFile || importing}
          onClick={handleZipImport}
        >
          {language === "uk" ? "Завантажити ZIP" : "Upload ZIP"}
        </button>
      </div>
    </section>
  );
}

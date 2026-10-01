import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { useTranslation } from "./i18n";
import type { Project } from "./ProjectSection";

export function ProjectPage() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState("");
  useEffect(() => {
    setProject(undefined);
    setError("");
    let active = true;
    const headers = new Headers();
    const token = getStoredAuthToken();
    if (token) headers.set("Authorization", "Bearer " + token);
    fetch("/api/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(projectId), { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error("Project not found or access denied");
        return response.json() as Promise<Project>;
      }).then((value) => { if (active) { setProject(value); setError(""); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Project unavailable"); });
    return () => { active = false; };
  }, [companyId, projectId]);
  return <main className="company-page project-page">
    <Link to={"/settings/company?company=" + encodeURIComponent(companyId)}>{language === "uk" ? "← До компанії" : "← Back to Company"}</Link>
    {error ? <p role="alert">{error}</p> : project ? <header><h1>{project.name}</h1><span className={"company-status " + project.status}>{project.status}</span></header> : <p>{language === "uk" ? "Завантаження проєкту…" : "Loading project…"}</p>}
  </main>;
}


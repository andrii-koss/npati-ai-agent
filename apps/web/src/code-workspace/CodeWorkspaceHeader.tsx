import { Link } from "react-router-dom";

export function CodeWorkspaceHeader({ isUk }: { isUk: boolean }) {
  return (
    <header className="inspector-header automations-header">
      <div className="automations-header-top">
        <div>
          <p className="eyebrow">{isUk ? "Кодовий агент та розробка" : "Code Agent & Workspace"}</p>
          <h1>
            <Link
              to="/settings/projects"
              className="marketplace-back-button"
              aria-label={isUk ? "Назад" : "Back"}
              title={isUk ? "Повернутися назад" : "Go back"}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span>{isUk ? "Робочий простір проєкту" : "Project workspace"}</span>
          </h1>
          <p className="hero-copy">
            {isUk
              ? "Керуйте розгортаннями й доменами, стежте за ресурсами та редагуйте файли проєкту."
              : "Manage deployments and domains, monitor resource usage, and edit project files."}
          </p>
        </div>
      </div>
    </header>
  );
}

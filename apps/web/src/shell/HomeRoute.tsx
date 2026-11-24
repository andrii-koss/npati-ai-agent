import { ReactNode, useCallback, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { AuthModal } from "../AuthModal";
import { useWorkspace } from "../BusinessWorkspace";
import { useTranslation } from "../i18n";
import { authFetch } from "./auth-helpers";
import { NpatiAgentLogo } from "./brand";

export function Home({ userMenu, logo }: { userMenu?: ReactNode; logo?: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { overview } = useWorkspace();
  const { isAuthenticated, isLoading } = useAuth();
  const { pathname } = useLocation();
  // /login and /signup are the landing page's buttons: they open the sign-in dialog right away.
  const authPath = pathname === "/login" ? "login" : pathname === "/signup" ? "register" : null;
  const [authModal, setAuthModal] = useState<{ open: boolean; mode: "login" | "register" }>({ open: authPath !== null, mode: authPath ?? "login" });
  // The server shows the public landing page at "/" (it marks the app page with this meta). A signed-out visitor who
  // reaches "/" inside the app, for example after signing out, reloads it to see that page.
  const landingAtRoot = pathname === "/" && typeof document !== "undefined" && document.querySelector('meta[name="npati-landing"]') !== null;
  useEffect(() => {
    if (landingAtRoot && !isLoading && !isAuthenticated) window.location.replace("/");
  }, [landingAtRoot, isLoading, isAuthenticated]);
  const closeAuthModal = useCallback(() => setAuthModal((prev) => ({ ...prev, open: false })), []);
  const handleAuthSuccess = useCallback(() => navigate("/chat"), [navigate]);

  const actionCards = [
    { title: t("home.actions.buildWebsite.title"), description: t("home.actions.buildWebsite.desc") },
    { title: t("home.actions.buildApplication.title"), description: t("home.actions.buildApplication.desc") },
    { title: t("home.actions.connectDatabase.title"), description: t("home.actions.connectDatabase.desc") },
    { title: t("home.actions.improveProject.title"), description: t("home.actions.improveProject.desc") },
    { title: t("home.actions.researchBusiness.title"), description: t("home.actions.researchBusiness.desc") },
    { title: t("home.actions.automateWork.title"), description: t("home.actions.automateWork.desc") },
  ];

  async function startChat(prompt: string) {
    if (!isAuthenticated) {
      setAuthModal({ open: true, mode: "login" });
      return;
    }
    const business = overview?.currentBusiness;
    if (!business) {
      navigate("/chat", { state: { prompt } });
      return;
    }
    const response = await authFetch(`/api/businesses/${business.id}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: prompt }),
    });
    if (!response.ok) {
      navigate("/chat", { state: { prompt } });
      return;
    }
    const conversation = (await response.json()) as { id: string };
    window.dispatchEvent(new Event("npati:conversations-changed"));
    navigate(`/c/${conversation.id}`, { state: { prompt } });
  }

  if (isLoading && !isAuthenticated) return <div className="workspace" />;
  if (isAuthenticated) return <Navigate to="/chat" replace />;
  if (landingAtRoot) return <div className="workspace" />;

  return (
    <main className="home-shell">
      <header className="home-header">
        <Link className="brand" to="/">
          {logo ?? <NpatiAgentLogo />}
        </Link>
        {isAuthenticated ? (
          <div className="home-auth-nav">{userMenu}</div>
        ) : (
          <div className="home-auth-nav">
            <button
              className="button-primary home-auth-btn"
              onClick={() => setAuthModal({ open: true, mode: "login" })}
            >
              {t("home.signIn")}
            </button>
          </div>
        )}
      </header>
      <section className="hero">
        <div className="hero-header-block">
          <p className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            {t("home.eyebrow")}
          </p>
          <h1>{t("home.heading")}</h1>
          <p className="hero-copy">{t("home.subheading")}</p>
        </div>

        <div className="action-grid">
          {actionCards.map((card, index) => (
            <button key={card.title} className="action-card" onClick={() => void startChat(card.title)}>
              <span className="action-number">0{index + 1}</span>
              <span>
                <strong>{card.title}</strong>
                <small>{card.description}</small>
              </span>
              <span className="action-arrow">
                <span className="action-arrow-glyph">→</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      <footer className="home-footer">
        {t("home.footerPrefix")}{" "}
        <a href="https://www.npati.com/" target="_blank" rel="noreferrer">
          {t("home.footerLink")}
        </a>
      </footer>
      <AuthModal
        isOpen={authModal.open}
        initialMode={authModal.mode}
        onClose={closeAuthModal}
        onSuccess={handleAuthSuccess}
      />
    </main>
  );
}

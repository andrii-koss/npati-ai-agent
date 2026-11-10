import { ReactNode, useCallback, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
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
  const [authModal, setAuthModal] = useState<{ open: boolean; mode: "login" | "register" }>({ open: false, mode: "login" });
  const closeAuthModal = useCallback(() => setAuthModal((prev) => ({ ...prev, open: false })), []);
  const handleAuthSuccess = useCallback(() => navigate("/chat"), [navigate]);

  const actionCards = [
    { title: t("home.actions.sellSomething.title"), description: t("home.actions.sellSomething.desc") },
    { title: t("home.actions.startBusiness.title"), description: t("home.actions.startBusiness.desc") },
    { title: t("home.actions.growBusiness.title"), description: t("home.actions.growBusiness.desc") },
    { title: t("home.actions.improveBusiness.title"), description: t("home.actions.improveBusiness.desc") },
    { title: t("home.actions.createContent.title"), description: t("home.actions.createContent.desc") },
    { title: t("home.actions.askAgent.title"), description: t("home.actions.askAgent.desc") },
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

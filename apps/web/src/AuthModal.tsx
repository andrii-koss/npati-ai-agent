import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type InstallationPairing, useAuth } from "./AuthContext";

export interface AuthModalProps {
  isOpen: boolean;
  initialMode?: "login" | "register";
  onClose: () => void;
  onSuccess?: () => void;
}
function buildNpatiSignInUrl(verificationUriComplete: string): string {
  const connectUrl = new URL(verificationUriComplete);
  const segments = connectUrl.pathname.split("/").filter(Boolean);
  const marketPrefix = segments.at(-2) === "agent" && segments.length > 2 ? `/${segments[0]}` : "";
  const signInUrl = new URL(`${marketPrefix}/sign-in`, connectUrl.origin);
  signInUrl.searchParams.set("redirectUrl", `${connectUrl.pathname}${connectUrl.search}${connectUrl.hash}`);
  return signInUrl.toString();
}



export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const navigate = useNavigate();
  const { beginInstallationConnection, pollInstallationConnection } = useAuth();
  const [pairing, setPairing] = useState<InstallationPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPairing(null);
      setBusy(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    const poll = async () => {
      try {
        const connected = await pollInstallationConnection(pairing.deviceCode);
        if (connected && !stopped) {
          onSuccess?.();
          if (!onSuccess) navigate("/chat");
          onClose();
        }
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : "NPATI account connection failed.");
          setBusy(false);
        }
      }
    };
    const timer = window.setInterval(poll, Math.max(5, pairing.interval) * 1000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [navigate, onClose, onSuccess, pairing, pollInstallationConnection]);

  if (!isOpen) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await beginInstallationConnection();
      setPairing(next);
      window.open(buildNpatiSignInUrl(next.verificationUriComplete), "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to NPATI.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="auth-modal-card" onClick={(event) => event.stopPropagation()}>
        <button className="auth-modal-close" onClick={onClose} aria-label="Close authentication dialog">&times;</button>
        <div className="auth-modal-header">
          <h2>Connect your NPATI Account</h2>
          <p>Authentication happens only on the official NPATI website. This installation never receives your password.</p>
        </div>

        {error && <div className="auth-error-notice" role="alert"><span>{error}</span></div>}

        {pairing ? (
          <div className="auth-modal-form">
            <p>Enter this one-time code on NPATI:</p>
            <strong style={{ fontSize: "1.4rem", letterSpacing: "0.08em", textAlign: "center" }}>{pairing.userCode}</strong>
            <a className="button-primary auth-submit-button" href={buildNpatiSignInUrl(pairing.verificationUriComplete)} target="_blank" rel="noreferrer">
              Open NPATI and approve
            </a>
            <small>Waiting for approval. This code expires in {Math.ceil(pairing.expiresIn / 60)} minutes.</small>
          </div>
        ) : (
          <button type="button" className="button-primary auth-submit-button" disabled={busy} onClick={start}>
            {busy ? "Connecting to NPATI..." : "Connect NPATI Account"}
          </button>
        )}

        <div className="auth-modal-footer">
          <small>One NPATI account works on npati.com, ai.npati.com and self-hosted NPATI Agent.</small>
        </div>
      </div>
    </div>
  );
}

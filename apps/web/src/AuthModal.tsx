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
  const { beginInstallationConnection, pollInstallationConnection, isAuthenticated } = useAuth();
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
    if (isOpen && isAuthenticated) onClose();
  }, [isOpen, isAuthenticated, onClose]);

  useEffect(() => {
    if (!isOpen || isAuthenticated || !pairing) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const connected = await pollInstallationConnection(pairing.deviceCode);
        if (stopped) return;
        if (connected) {
          onSuccess?.();
          if (!onSuccess) navigate("/chat");
          onClose();
        } else {
          timer = window.setTimeout(poll, Math.max(5, pairing.interval) * 1000);
        }
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : "NPATI account connection failed.");
          setBusy(false);
          setPairing(null);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isOpen, isAuthenticated, navigate, onClose, onSuccess, pairing, pollInstallationConnection]);

  if (!isOpen || isAuthenticated) return null;

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
            <strong className="auth-modal-code">{pairing.userCode}</strong>
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

import { useState, useEffect, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export interface AuthModalProps {
  isOpen: boolean;
  initialMode?: "login" | "register";
  onClose: () => void;
  onSuccess?: () => void;
}

export function AuthModal({
  isOpen,
  initialMode = "login",
  onClose,
  onSuccess,
}: AuthModalProps) {
  const navigate = useNavigate();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError(null);
      setPassword("");
      setUsername("");
      setDisplayName("");
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register({
          email,
          password,
          username: username.trim(),
          displayName: displayName.trim() || undefined,
        });
      }
      if (onSuccess) {
        onSuccess();
      } else {
        navigate("/chat");
      }
      onClose();
    } catch (err: any) {
      setError(err.message || "Authentication failed. Please check your credentials.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="auth-modal-card" onClick={(e) => e.stopPropagation()}>
        <button
          className="auth-modal-close"
          onClick={onClose}
          aria-label="Close authentication dialog"
        >
          &times;
        </button>

        <div className="auth-modal-header">
          <h2>{mode === "login" ? "Sign in to NPATI" : "Create NPATI Account"}</h2>
          <p>
            {mode === "login"
              ? "Access your AI business workspace, memory, and companies."
              : "Register your single NPATI account to unlock NPATI Agent."}
          </p>
        </div>

        <div className="auth-tab-group" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={`auth-tab ${mode === "login" ? "active" : ""}`}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`auth-tab ${mode === "register" ? "active" : ""}`}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
          >
            Create account
          </button>
        </div>

        {error && (
          <div className="auth-error-notice" role="alert">
            <span className="auth-error-icon">&times;</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-modal-form">
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              required
              autoFocus
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>

          {mode === "register" && (
            <>
              <label className="auth-field">
                <span>Username</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. alex_biz"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                />
              </label>

              <label className="auth-field">
                <span>Display name (optional)</span>
                <input
                  type="text"
                  placeholder="e.g. Alex Johnson"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={busy}
                />
              </label>
            </>
          )}

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              required
              placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              minLength={mode === "register" ? 8 : undefined}
            />
          </label>

          <button
            type="submit"
            className="button-primary auth-submit-button"
            disabled={busy}
          >
            {busy
              ? "Connecting to NPATI…"
              : mode === "login"
              ? "Sign in"
              : "Create account"}
          </button>
        </form>

        <div className="auth-modal-footer">
          <small>
            NPATI Agent connects securely to the unified NPATI backend. Passwords are never stored locally.
          </small>
        </div>
      </div>
    </div>
  );
}

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

export interface ErrorBoundaryProps {
  children: ReactNode;
  title?: string;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  showBackToAgents?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] Component render error:", error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error ?? new Error("Unknown render error"), this.reset);
      }
      return (
        <div
          className="data-studio-alert error"
          role="alert"
          style={{
            margin: "20px 0",
            padding: "20px",
            borderRadius: "12px",
            border: "1px solid rgba(225, 29, 46, 0.3)",
            background: "rgba(225, 29, 46, 0.04)",
          }}
        >
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", color: "var(--npati-red, #e11d2e)" }}>
            {this.props.title || "Помилка відображення панелі / Component rendering error"}
          </h3>
          <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#64748b" }}>
            {this.state.error?.message || "Виникла помилка під час рендерингу компонента."}
          </p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              type="button"
              className="button-secondary"
              onClick={this.reset}
              style={{ minHeight: "36px", padding: "0 14px" }}
            >
              Спробувати знову / Retry
            </button>
            {this.props.showBackToAgents && (
              <Link
                to="/settings/code"
                className="button-primary"
                style={{ minHeight: "36px", padding: "0 14px", display: "inline-flex", alignItems: "center" }}
              >
                ← До списку агентів / Back to agents
              </Link>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

import React from "react";
import { modeChangeRequest, modeLabel, stopRequest } from "./actions";
import { CODE_SESSION_MODES, type ApiRequest, type CodeSessionMode, type UsageView } from "./types";

/**
 * C7: the workspace control panel — mode, model, Stop, cost, preview.
 *
 * It renders requests rather than performing them: `onRequest` receives the exact `ApiRequest` from the
 * pure mapping in actions.ts, so the panel cannot invent an endpoint and the page cannot skip the
 * mapping. When the feature flag is off every control that would change state is disabled, while the
 * usage/revision read-outs stay visible (read-only, per C7).
 */
export function ControlPanel({
  companyId,
  sessionId,
  revision,
  mode,
  models,
  model,
  usage,
  isWebProject = false,
  flagEnabled = true,
  isUk = false,
  onOpenPreview,
  onModelChange,
  onRequest,
}: {
  companyId: string;
  sessionId: string;
  revision: number;
  mode: CodeSessionMode;
  models: readonly string[];
  model: string;
  usage: UsageView;
  isWebProject?: boolean;
  flagEnabled?: boolean;
  isUk?: boolean;
  onOpenPreview?: () => void;
  onModelChange?: (model: string) => void;
  onRequest: (request: ApiRequest) => void;
}): React.ReactElement {
  const modeDisabled = !flagEnabled;
  const usageText = (): string => {
    if (usage.unavailable) {
      return isUk ? `Недоступно: ${usage.unavailable}` : `Unavailable: ${usage.unavailable}`;
    }
    const tokensIn = usage.tokensIn === null ? "—" : String(usage.tokensIn);
    const tokensOut = usage.tokensOut === null ? "—" : String(usage.tokensOut);
    const cost = usage.costUsd === null ? "—" : `$${usage.costUsd.toFixed(4)}`;
    return `${isUk ? "токени" : "tokens"}: ${tokensIn}/${tokensOut} · ${isUk ? "вартість" : "cost"}: ${cost}`;
  };

  return (
    <section className="code-detail-row" aria-label={isUk ? "Керування" : "Controls"} data-flag-enabled={flagEnabled}>
      <label className="browser-form-field">
        <span>{isUk ? "Режим" : "Mode"}</span>
        <select
          value={mode}
          disabled={modeDisabled}
          data-field="mode"
          onChange={(event) => {
            const next = event.target.value as CodeSessionMode;
            onRequest(modeChangeRequest({ companyId, sessionId, mode: next, expectedRevision: revision }));
          }}
        >
          {CODE_SESSION_MODES.map((entry) => (
            <option key={entry} value={entry}>
              {modeLabel(entry, isUk)}
            </option>
          ))}
        </select>
      </label>

      <label className="browser-form-field">
        <span>{isUk ? "Модель" : "Model"}</span>
        {onModelChange ? (
          <select
            value={model}
            disabled={modeDisabled}
            data-field="model"
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        ) : (
          // Without a handler the model is a read-out, not a control: rendering a disabled select would
          // suggest the user can change it, and an enabled one would silently do nothing.
          <span className="ds-muted" data-field="model">
            {model}
          </span>
        )}
      </label>

      <div className="browser-form-footer">
        <button
          type="button"
          className="button-secondary"
          disabled={!flagEnabled}
          data-action="stop"
          onClick={() => onRequest(stopRequest({ companyId, sessionId }))}
        >
          {isUk ? "Зупинити" : "Stop"}
        </button>
        {isWebProject && onOpenPreview ? (
          <button type="button" className="button-secondary" data-action="open-preview" onClick={onOpenPreview}>
            {isUk ? "Відкрити Preview" : "Open Preview"}
          </button>
        ) : null}
      </div>

      <div className="ds-muted" data-field="usage">
        {usageText()}
      </div>
      <div className="ds-muted" data-field="revision">{`revision: ${revision}`}</div>
    </section>
  );
}

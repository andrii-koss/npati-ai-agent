import React from "react";
import type { ProjectAuthSettings } from "@npati/shared";

export interface DataStudioAuthSettingsTabProps {
  settingsLoading: boolean;
  settings: ProjectAuthSettings | null;
  setSettings: React.Dispatch<React.SetStateAction<ProjectAuthSettings | null>>;
  isUk: boolean;
  rotatingKeys: boolean;
  handleRotateSigningKey: () => Promise<void>;
  redirectUrls: string;
  setRedirectUrls: (val: string) => void;
  savingRedirects: boolean;
  handleSaveRedirectUrls: () => Promise<void>;
  savingSettings: boolean;
  handleSaveSettings: () => Promise<void>;
}

export function DataStudioAuthSettingsTab({
  settingsLoading,
  settings,
  setSettings,
  isUk,
  rotatingKeys,
  handleRotateSigningKey,
  redirectUrls,
  setRedirectUrls,
  savingRedirects,
  handleSaveRedirectUrls,
  savingSettings,
  handleSaveSettings,
}: DataStudioAuthSettingsTabProps) {
  return (
    <div className="auth-content">
      {settingsLoading || !settings ? (
        <div className="auth-loading-state">
          <p>{isUk ? "Завантаження налаштувань…" : "Loading settings…"}</p>
        </div>
      ) : (
        <div className="auth-settings-grid">
          <div className="settings-card">
            <h3>{isUk ? "Реєстрація та верифікація" : "Registration & Verification"}</h3>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.allowRegistration}
                onChange={(e) => setSettings({ ...settings, allowRegistration: e.target.checked })}
              />
              <div>
                <strong>{isUk ? "Дозволити реєстрацію користувачів" : "Allow User Registration"}</strong>
                <p>{isUk ? "Кінцеві користувачі можуть самостійно реєструватися" : "Enable sign-up on public site"}</p>
              </div>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.requireEmailVerification}
                onChange={(e) => setSettings({ ...settings, requireEmailVerification: e.target.checked })}
              />
              <div>
                <strong>{isUk ? "Вимагати підтвердження email" : "Require Email Verification"}</strong>
                <p>
                  {isUk
                    ? "Користувачі повинні підтвердити email перед входом (потрібен налаштований email)"
                    : "Users must verify their email before sign-in (requires email provider)"}
                </p>
              </div>
            </label>
          </div>

          <div className="settings-card">
            <h3>{isUk ? "Політика паролів" : "Password Policy"}</h3>
            <div className="form-group">
              <label>{isUk ? "Мінімальна довжина пароля" : "Minimum Password Length"}</label>
              <input
                type="number"
                min={6}
                max={64}
                value={settings.minPasswordLength}
                onChange={(e) => setSettings({ ...settings, minPasswordLength: Number(e.target.value) })}
              />
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.requireNumbers}
                onChange={(e) => setSettings({ ...settings, requireNumbers: e.target.checked })}
              />
              <div>
                <strong>{isUk ? "Вимагати цифри" : "Require Numbers"}</strong>
              </div>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.requireSymbols}
                onChange={(e) => setSettings({ ...settings, requireSymbols: e.target.checked })}
              />
              <div>
                <strong>{isUk ? "Вимагати спеціальні символи" : "Require Symbols"}</strong>
              </div>
            </label>
          </div>

          <div className="settings-card">
            <h3>{isUk ? "Час життя токенів (TTL)" : "Token Lifetimes"}</h3>
            <div className="form-group">
              <label>{isUk ? "Access Token TTL (хвилини)" : "Access Token TTL (minutes)"}</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={settings.accessTokenTtlMinutes}
                onChange={(e) => setSettings({ ...settings, accessTokenTtlMinutes: Number(e.target.value) })}
              />
            </div>

            <div className="form-group">
              <label>{isUk ? "Refresh Token TTL (дні)" : "Refresh Token TTL (days)"}</label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.refreshTokenTtlDays}
                onChange={(e) => setSettings({ ...settings, refreshTokenTtlDays: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="settings-card keys-card">
            <h3>{isUk ? "Ключі підпису (Ed25519)" : "Signing Keys (Ed25519)"}</h3>
            <p>
              {isUk
                ? "Токени підписуються асиметричним ключем Ed25519 з підтримкою безшовної ротації."
                : "Tokens are signed with Ed25519 asymmetric keys with seamless key rotation support."}
            </p>
            <button
              type="button"
              className="button-secondary"
              disabled={rotatingKeys}
              onClick={() => void handleRotateSigningKey()}
            >
              {rotatingKeys ? (isUk ? "Ротація…" : "Rotating…") : isUk ? "🔄 Ротувати ключі підпису" : "🔄 Rotate Signing Keys"}
            </button>
          </div>

          <div className="settings-card">
            <h3>{isUk ? "Redirect URLs (deep links)" : "Redirect URLs (deep links)"}</h3>
            <p>
              {isUk
                ? "Лише ці адреси можуть отримувати посилання підтвердження email і скидання пароля. Для мобільного застосунку додайте його deep link, наприклад npati-shop://auth/callback (по одному на рядок)."
                : "Only these targets may receive email verification and password reset links. For a mobile app add its deep link, for example npati-shop://auth/callback (one per line)."}
            </p>
            <textarea
              rows={4}
              value={redirectUrls}
              onChange={(event) => setRedirectUrls(event.target.value)}
              placeholder={"https://shop.example.com/auth/callback\nnpati-shop://auth/callback"}
            />
            <button
              type="button"
              className="button-secondary"
              disabled={savingRedirects}
              onClick={() => void handleSaveRedirectUrls()}
            >
              {savingRedirects ? (isUk ? "Збереження…" : "Saving…") : isUk ? "Зберегти redirect URLs" : "Save redirect URLs"}
            </button>
          </div>

          <div className="settings-footer">
            <button
              type="button"
              className="button-primary save-settings-btn"
              disabled={savingSettings}
              onClick={() => void handleSaveSettings()}
            >
              {savingSettings ? (isUk ? "Збереження…" : "Saving…") : isUk ? "Зберегти налаштування" : "Save Settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

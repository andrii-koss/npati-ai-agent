import type { DataClassification, RetentionClass, SessionMode, SessionStatus } from "./types";

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

/** Human copy for the error codes the Code API can return. */
export function codeErrorMessage(error: unknown, isUk: boolean): string {
  const code = errorCode(error);
  const fallback = error instanceof Error ? error.message : isUk ? "Запит не вдався" : "Request failed";
  switch (code) {
    case "code_unavailable":
    case "project_import_unavailable":
      return isUk
        ? "Модуль Code вимкнено на цій інсталяції (feature flag або відсутній import-сервіс)."
        : "The Code module is disabled on this installation (feature flag or missing import service).";
    case "code_write_denied":
      return isUk ? "Немає права створювати код-проєкти в цій компанії." : "You are not allowed to create code projects in this company.";
    case "invalid_name":
      return isUk ? "Некоректна назва проєкту." : "The project name is invalid.";
    case "invalid_repository_url":
      return isUk ? "Некоректний URL репозиторію (потрібен https:// або git@)." : "Invalid repository URL (https:// or git@ expected).";
    case "repository_import_failed":
      return isUk ? "Не вдалося імпортувати репозиторій. Спробуйте ще раз." : "Repository import failed. Please retry.";
    case "classification_downgrade_denied":
      return isUk ? "Зниження класу даних заборонено." : "Lowering the data classification is not allowed.";
    case "retention_downgrade_denied":
      return isUk ? "Скорочення класу зберігання заборонено." : "Shortening the retention class is not allowed.";
    case "feature_disabled":
      return isUk
        ? "Coding Agent вимкнено (History read-only): створення й зміни недоступні, історія, Activity, Changes/diff, Export і Delete працюють."
        : "The Coding Agent is disabled (History read-only): creation and mutations are unavailable while history, Activity, Changes/diff, Export and Delete still work.";
    case "flag_admin_required":
      return isUk ? "Керувати флагами може лише власник/адміністратор компанії." : "Only the company owner/admin can manage flags.";
    default:
      return fallback;
  }
}

export function formatDate(value: string | undefined, isUk: boolean): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(isUk ? "uk-UA" : "en-US", { dateStyle: "short", timeStyle: "short" });
}

export function classificationLabel(value: DataClassification | undefined, isUk: boolean): string {
  switch (value) {
    case "public": return isUk ? "публічні" : "public";
    case "internal": return isUk ? "внутрішні" : "internal";
    case "confidential": return isUk ? "конфіденційні" : "confidential";
    case "restricted": return isUk ? "суворо обмежені" : "restricted";
    default: return "—";
  }
}

export function retentionLabel(value: RetentionClass | undefined, isUk: boolean): string {
  switch (value) {
    case "ephemeral": return isUk ? "ефемерне" : "ephemeral";
    case "short": return isUk ? "коротке" : "short";
    case "standard": return isUk ? "стандартне" : "standard";
    case "extended": return isUk ? "подовжене" : "extended";
    case "until_deleted": return isUk ? "до видалення" : "until deleted";
    default: return "—";
  }
}

export function sessionModeLabel(value: SessionMode | string | undefined, isUk: boolean): string {
  switch (value) {
    case "plan": return isUk ? "план" : "plan";
    case "ask": return isUk ? "запит" : "ask";
    case "auto_edit": return isUk ? "авторедагування" : "auto edit";
    case "full_auto_sandbox": return isUk ? "повний авто (sandbox)" : "full auto (sandbox)";
    // Legacy C1 spellings stay renderable: sessions persisted before C5 may still carry them.
    case "edit": return isUk ? "редагування" : "edit";
    case "auto": return isUk ? "авто" : "auto";
    case "full_auto": return isUk ? "повний авто" : "full auto";
    default: return "—";
  }
}

export function sessionStatusLabel(value: SessionStatus | undefined, isUk: boolean): string {
  switch (value) {
    case "active": return isUk ? "активна" : "active";
    case "paused": return isUk ? "пауза" : "paused";
    case "awaiting_approval": return isUk ? "очікує підтвердження" : "awaiting approval";
    case "completed": return isUk ? "завершена" : "completed";
    case "failed": return isUk ? "помилка" : "failed";
    case "cancelled": return isUk ? "скасована" : "cancelled";
    case "archived": return isUk ? "в архіві" : "archived";
    default: return "—";
  }
}

export function projectStatusClass(status: string | undefined): string {
  switch (status) {
    case "active":
    case "ready":
      return "verified";
    case "provisioning":
    case "importing":
      return "partial";
    case "archived":
      return "blocked";
    case "failed":
    case "error":
      return "failed";
    default:
      return "queued";
  }
}

export function sessionStatusClass(status: SessionStatus | undefined): string {
  switch (status) {
    case "active": return "running";
    case "paused": return "partial";
    case "awaiting_approval": return "requires-approval";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "blocked";
    case "archived": return "not-implemented";
    default: return "queued";
  }
}

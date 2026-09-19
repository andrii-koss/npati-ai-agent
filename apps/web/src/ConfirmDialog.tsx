import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "./i18n";

export interface DialogOptions {
  title?: string;
  message: string;
  type?: "confirm" | "alert" | "prompt";
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

interface DialogState extends DialogOptions {
  id: number;
  isOpen: boolean;
  resolve: (value: any) => void;
}

type DialogListener = (state: DialogState | null) => void;
let activeListener: DialogListener | null = null;
let dialogCounter = 0;

export function confirmModal(options: DialogOptions | string): Promise<boolean> {
  const opts: DialogOptions = typeof options === "string" ? { message: options } : options;
  const isDangerAction =
    opts.isDanger !== undefined
      ? opts.isDanger
      : /delete|видалити|remove|destroy|cancel/i.test(opts.message) ||
        (opts.title ? /delete|видалити|remove/i.test(opts.title) : false);

  return new Promise<boolean>((resolve) => {
    if (!activeListener) {
      resolve(window.confirm(opts.message));
      return;
    }
    dialogCounter++;
    activeListener({
      id: dialogCounter,
      isOpen: true,
      title: opts.title || (isDangerAction ? "Delete confirmation" : "Confirmation"),
      message: opts.message,
      type: "confirm",
      confirmText: opts.confirmText || (isDangerAction ? "Delete" : "Confirm"),
      cancelText: opts.cancelText || "Cancel",
      isDanger: isDangerAction,
      resolve,
    });
  });
}

export function alertModal(options: DialogOptions | string): Promise<void> {
  const opts: DialogOptions = typeof options === "string" ? { message: options } : options;
  return new Promise<void>((resolve) => {
    if (!activeListener) {
      window.alert(opts.message);
      resolve();
      return;
    }
    dialogCounter++;
    activeListener({
      id: dialogCounter,
      isOpen: true,
      title: opts.title || "Notification",
      message: opts.message,
      type: "alert",
      confirmText: opts.confirmText || "OK",
      isDanger: opts.isDanger || false,
      resolve: () => resolve(),
    });
  });
}

export function promptModal(
  options: DialogOptions | string,
  defaultValue = ""
): Promise<string | null> {
  const opts: DialogOptions = typeof options === "string" ? { message: options } : options;
  const initialVal = opts.defaultValue ?? defaultValue;

  return new Promise<string | null>((resolve) => {
    if (!activeListener) {
      resolve(window.prompt(opts.message, initialVal));
      return;
    }
    dialogCounter++;
    activeListener({
      id: dialogCounter,
      isOpen: true,
      title: opts.title || "Input required",
      message: opts.message,
      type: "prompt",
      defaultValue: initialVal,
      placeholder: opts.placeholder || "",
      confirmText: opts.confirmText || "Save",
      cancelText: opts.cancelText || "Cancel",
      isDanger: false,
      resolve,
    });
  });
}

export function ConfirmDialogContainer() {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeListener = (state) => {
      setDialog(state);
      if (state && state.type === "prompt") {
        setInputValue(state.defaultValue || "");
      }
    };
    return () => {
      activeListener = null;
    };
  }, []);

  useEffect(() => {
    if (dialog?.isOpen) {
      if (dialog.type === "prompt") {
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 50);
      } else {
        setTimeout(() => {
          confirmButtonRef.current?.focus();
        }, 50);
      }
    }
  }, [dialog]);

  useEffect(() => {
    if (!dialog?.isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter" && dialog.type !== "prompt") {
        e.preventDefault();
        handleConfirm();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialog, inputValue]);

  if (!dialog || !dialog.isOpen) return null;

  const defaultTitle = dialog.isDanger
    ? t("common.deleteConfirmation")
    : dialog.type === "alert"
    ? t("common.notification")
    : dialog.type === "prompt"
    ? t("common.inputRequired")
    : t("common.confirmation");

  const dialogTitle = (!dialog.title || ["Delete confirmation", "Confirmation", "Notification", "Input required"].includes(dialog.title))
    ? defaultTitle
    : dialog.title;

  const confirmLabel = (!dialog.confirmText || ["Delete", "OK", "Confirm", "Save"].includes(dialog.confirmText))
    ? (dialog.isDanger ? t("common.delete") : dialog.type === "alert" ? t("common.ok") : dialog.type === "prompt" ? t("common.save") : t("common.confirm"))
    : dialog.confirmText;

  const cancelLabel = (!dialog.cancelText || dialog.cancelText === "Cancel")
    ? t("common.cancel")
    : dialog.cancelText;

  const handleCancel = () => {
    const res = dialog.resolve;
    setDialog(null);
    if (dialog.type === "prompt") {
      res(null);
    } else if (dialog.type === "confirm") {
      res(false);
    } else {
      res(undefined);
    }
  };

  const handleConfirm = () => {
    const res = dialog.resolve;
    setDialog(null);
    if (dialog.type === "prompt") {
      res(inputValue);
    } else if (dialog.type === "confirm") {
      res(true);
    } else {
      res(undefined);
    }
  };

  return (
    <div
      className="npati-dialog-backdrop"
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="npati-dialog-title"
    >
      <div
        className={`npati-dialog-card ${dialog.isDanger ? "is-danger" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="npati-dialog-close"
          onClick={handleCancel}
          aria-label={t("common.close")}
          type="button"
        >
          &times;
        </button>

        <div className="npati-dialog-header">
          <div
            className={`npati-dialog-icon ${
              dialog.isDanger ? "danger" : dialog.type === "alert" ? "info" : "accent"
            }`}
          >
            {dialog.isDanger ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            ) : dialog.type === "alert" ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : dialog.type === "prompt" ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
          </div>

          <div className="npati-dialog-headings">
            <h3 id="npati-dialog-title" className="npati-dialog-title">
              {dialogTitle}
            </h3>
            <p className="npati-dialog-message">{dialog.message}</p>
          </div>
        </div>

        {dialog.type === "prompt" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            className="npati-dialog-form"
          >
            <input
              ref={inputRef}
              type="text"
              className="npati-dialog-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={dialog.placeholder}
            />
          </form>
        )}

        <div className="npati-dialog-actions">
          {dialog.type !== "alert" && (
            <button
              type="button"
              className="npati-dialog-btn npati-dialog-btn-cancel"
              onClick={handleCancel}
            >
              {cancelLabel}
            </button>
          )}

          <button
            ref={confirmButtonRef}
            type="button"
            className={`npati-dialog-btn ${
              dialog.isDanger ? "npati-dialog-btn-danger" : "npati-dialog-btn-primary"
            }`}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

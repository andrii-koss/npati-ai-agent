import React, { useEffect, useRef, useState } from "react";
import type { GdprAffectedData, ProjectAuthUser } from "@npati/shared";
import { promptModal } from "./ConfirmDialog";

type UserList = { users: ProjectAuthUser[]; total: number };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
interface Options {
  basePath: string;
  search: string;
  statusFilter: string;
  users: ProjectAuthUser[];
  usersTotal: number;
  isUk: boolean;
  api: Api;
  reload: () => Promise<void>;
  notify: (message: string, type?: "success" | "info" | "error") => void;
}

export function useAuthUserBulkActions(options: Options) {
  const { basePath, search, statusFilter, users, usersTotal, isUk, api, reload, notify } = options;
  const scope = JSON.stringify([basePath, search, statusFilter]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [selection, setSelection] = useState({ scope, ids: new Set<string>() });
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    currentScope.current = scope;
    setSelection(previous => previous.scope === scope ? previous : { scope, ids: new Set<string>() });
    return () => { if (currentScope.current === scope) currentScope.current = ""; };
  }, [scope]);
  const selected = selection.scope === scope ? selection.ids : new Set<string>();
  const busy = busyScope === scope;
  const allVisible = users.length > 0 && users.every(user => selected.has(user.id));
  const someVisible = users.some(user => selected.has(user.id));
  const update = (ids: Set<string>) => setSelection({ scope, ids });
  const toggle = (id: string) => {
    const ids = new Set(selected);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    update(ids);
  };
  const toggleVisible = () => {
    const ids = new Set(selected);
    for (const user of users) {
      if (allVisible) ids.delete(user.id); else ids.add(user.id);
    }
    update(ids);
  };

  const selectAll = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusyScope(scope);
    try {
      const ids = new Set<string>();
      let offset = 0;
      let total = usersTotal;
      do {
        const query = new URLSearchParams({ limit: "100", offset: String(offset) });
        if (search.trim()) query.set("search", search.trim());
        if (statusFilter) query.set("status", statusFilter);
        const page = await api<UserList>(`${basePath}/users?${query}`);
        if (currentScope.current !== scope) return;
        const previousSize = ids.size;
        page.users.forEach(user => ids.add(user.id));
        total = page.total;
        offset += page.users.length;
        if (ids.size === previousSize && offset < total) {
          throw new Error(isUk ? "Список змінився. Оновіть його та повторіть вибір." : "The list changed. Refresh it and select again.");
        }
      } while (offset < total);
      if (ids.size < total) throw new Error(isUk ? "Список змінився. Повторіть вибір." : "The list changed. Select again.");
      update(ids);
    } catch (error) {
      if (currentScope.current === scope) notify((error as Error).message, "error");
    } finally {
      lock.current = false;
      setBusyScope(null);
    }
  };

  const run = async (action: "roles" | "delete") => {
    if (lock.current || !selected.size) return;
    lock.current = true;
    setBusyScope(scope);
    const ids = [...selected];
    try {
      let roles: string[] = [];
      if (action === "roles") {
        const input = await promptModal({
          title: isUk ? `Змінити ролі: ${ids.length}` : `Change roles: ${ids.length}`,
          message: isUk
            ? "Нові ролі замінять поточні для всіх вибраних користувачів. Введіть ролі через кому:"
            : "These roles will replace the current roles for every selected user. Enter comma-separated roles:",
          defaultValue: "user",
          confirmText: isUk ? "Застосувати" : "Apply",
        });
        if (input === null) return;
        roles = [...new Set(input.split(",").map(role => role.trim()).filter(Boolean))];
        if (!roles.length) {
          notify(isUk ? "Вкажіть принаймні одну роль." : "Enter at least one role.", "error");
          return;
        }
        if (roles.some(role => !/^[a-z][a-z0-9_-]{0,31}$/.test(role))) {
          notify(isUk ? "Ролі: малі латинські літери, цифри, _ або -, до 32 символів." : "Roles must start with a lowercase letter and contain lowercase letters, numbers, _ or -, up to 32 characters.", "error");
          return;
        }
      } else {
        // Use the same deletion preview and GDPR endpoint as individual deletion.
        for (const id of ids) {
          if (currentScope.current !== scope) return;
          await api<GdprAffectedData>(`${basePath}/users/${encodeURIComponent(id)}/delete/preview`, { method: "POST" });
        }
        if (currentScope.current !== scope) return;
        const answer = await promptModal({
          title: isUk ? `Видалити користувачів: ${ids.length}` : `Delete users: ${ids.length}`,
          message: isUk
            ? `Буде видалено ${ids.length} користувачів. Пов’язані дані буде оброблено за налаштуваннями GDPR. Дію неможливо скасувати. Введіть delete для підтвердження:`
            : `${ids.length} users will be deleted. Related data will be handled according to GDPR settings. This cannot be undone. Type delete to confirm:`,
          confirmText: isUk ? "Видалити" : "Delete",
          isDanger: true,
        });
        if (answer?.trim().toLowerCase() !== "delete") return;
      }
      if (currentScope.current !== scope) return;
      const failed = new Set<string>();
      let completed = 0;
      let firstError = "";
      for (const id of ids) {
        if (currentScope.current !== scope) return;
        try {
          await api(`${basePath}/users/${encodeURIComponent(id)}${action === "roles" ? "/roles" : ""}`, {
            method: action === "roles" ? "PATCH" : "DELETE",
            body: JSON.stringify(action === "roles" ? { roles } : { confirmed: true }),
          });
          completed++;
        } catch (error) {
          failed.add(id);
          firstError ||= (error as Error).message;
        }
      }
      if (currentScope.current !== scope) return;
      update(failed);
      const summary = isUk
        ? `Виконано: ${completed} із ${ids.length}.`
        : `Completed: ${completed} of ${ids.length}.`;
      notify(failed.size ? `${summary} ${firstError}` : summary, failed.size ? "error" : "success");
      await reload();
    } catch (error) {
      if (currentScope.current === scope) notify((error as Error).message, "error");
    } finally {
      lock.current = false;
      setBusyScope(null);
    }
  };

  return { selected, busy, allVisible, someVisible, toggle, toggleVisible,
    clear: () => update(new Set()), selectAll, run };
}

export function AuthUserBulkToolbar({ bulk, total, isUk, disabled }: {
  bulk: ReturnType<typeof useAuthUserBulkActions>;
  total: number;
  isUk: boolean;
  disabled: boolean;
}) {
  if (!bulk.selected.size && !bulk.busy) return null;
  const blocked = disabled || bulk.busy;
  return (
    <div className="auth-user-bulk-toolbar" aria-busy={bulk.busy}>
      <span role="status">{isUk ? "Вибрано" : "Selected"}: {bulk.selected.size}</span>
      {bulk.selected.size < total && <button type="button" className="button-secondary" disabled={blocked} onClick={() => void bulk.selectAll()}>
        {isUk ? `Вибрати всі (${total})` : `Select all (${total})`}
      </button>}
      <span className="auth-user-bulk-spacer" />
      <button type="button" className="button-secondary" disabled={blocked} onClick={() => void bulk.run("roles")}>{isUk ? "Змінити ролі" : "Change roles"}</button>
      <button type="button" className="button-secondary danger" disabled={blocked} onClick={() => void bulk.run("delete")}>{isUk ? "Видалити" : "Delete"}</button>
      <button type="button" className="button-secondary" disabled={blocked} onClick={bulk.clear}>{isUk ? "Скасувати вибір" : "Clear selection"}</button>
    </div>
  );
}

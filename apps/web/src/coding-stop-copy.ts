/** Render runtime quota stops in the request language; keep the raw journal intact. */
export function codingStopCopy(text: string, language = "en"): string {
  if (!/^(?:Stopped:\s*)?(?:budget_exhausted$|A2A_(?:TOKEN|COST|DAILY)_QUOTA_EXCEEDED\b)/u.test(text.trim())) return text;
  const copy: Record<string,string> = {
    en:"The configured execution budget has been reached. Your changes are saved, but the task is unfinished.",
    uk:"Вичерпано налаштований бюджет виконання. Зміни збережено, але завдання ще не завершене.",
    de:"Das konfigurierte Ausführungsbudget ist aufgebraucht. Die Änderungen sind gespeichert, die Aufgabe ist aber noch nicht abgeschlossen.",
    fr:"Le budget d’exécution configuré est épuisé. Les modifications sont enregistrées, mais la tâche reste inachevée.",
    es:"Se ha agotado el presupuesto de ejecución configurado. Los cambios están guardados, pero la tarea sigue sin terminar.",
    it:"Il budget di esecuzione configurato è esaurito. Le modifiche sono salvate, ma il lavoro non è ancora completo.",
    pl:"Wyczerpano skonfigurowany budżet wykonania. Zmiany zostały zapisane, ale zadanie nie jest jeszcze ukończone.",
    pt:"O orçamento de execução configurado foi esgotado. As alterações estão salvas, mas a tarefa ainda não foi concluída.",
  };
  return copy[language] ?? copy.en!;
}

import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "Управление и безопасность",
    "title": "Обзор возможностей",
    "backAria": "Вернуться к настройкам",
    "modelProfiles": {
      "title": "Профили моделей: консервативный резервный режим.",
      "emptyHint": "Для этого контекста не включён ни один флаг code.model_profile.<id>, поэтому все запуски используют консервативный профиль (один вызов инструмента за раз, автоматическое определение поддержки инструментов), даже если модель соответствует одному из {{count}} профилей реестра. Включите флаги разрешённых в этом развёртывании профилей, чтобы начать внедрение."
    },
    "heroCopy": "Изучайте и проверяйте 306 канонических возможностей NPATI Agent. Проверяйте границы Effective Capability Resolver, видимость инструментов и политики рисков в действующей среде.",
    "stats": {
      "totalLabel": "всего возможностей",
      "totalDesc": "Проверенные канонические ID 1..306",
      "agentCallableLabel": "доступны агенту",
      "agentCallableDesc": "Предоставлены моделям через Resolver",
      "runtimeOnlyLabel": "внутренняя среда",
      "runtimeOnlyDesc": "Изолированные операции движка",
      "requiresApprovalLabel": "требуют одобрения",
      "requiresApprovalDesc": "Проверка безопасности с участием человека"
    },
    "slices": {
      "all": "Все",
      "agentCallable": "Доступно агенту",
      "runtimeOnly": "Только среда выполнения",
      "userVisible": "Видимо пользователю",
      "automatic": "Автоматически",
      "allowed": "Разрешено",
      "requiresApproval": "Требуется одобрение"
    },
    "controls": {
      "searchPlaceholder": "Фильтр возможностей по названию, ID или области...",
      "searchAriaLabel": "Фильтр возможностей",
      "clearSearch": "Очистить поиск",
      "showing": "Показано возможностей: {{start}}–{{end}} из {{total}}",
      "matching": "по запросу «{{term}}»",
      "copied": "✓ Скопировано {{id}}",
      "perPage": "На странице:",
      "allCount": "Все ({{total}})"
    },
    "table": {
      "colId": "ID",
      "sortId": "Сортировать по ID",
      "colName": "Название",
      "sortName": "Сортировать по названию",
      "colCanonicalId": "Канонический ID",
      "sortCanonicalId": "Сортировать по каноническому ID",
      "colDomain": "Область",
      "sortDomain": "Сортировать по области",
      "colType": "Тип",
      "sortType": "Сортировать по типу",
      "colCallable": "Доступность вызова",
      "colRisk": "Риск",
      "sortRisk": "Сортировать по риску",
      "colStatus": "Статус",
      "sortStatus": "Сортировать по статусу",
      "copyTooltip": "Нажмите, чтобы скопировать канонический ID",
      "empty": "Нет возможностей, соответствующих фильтру.",
      "prev": "← Назад",
      "next": "Далее →"
    },
    "callable": {
      "callable": "Доступность вызова",
      "internal": "Внутренний"
    },
    "risks": {
      "low": "Низкий",
      "medium": "Средний",
      "high": "Высокий",
      "critical": "Критический"
    },
    "statuses": {
      "verified": "Проверено",
      "partial": "Частично",
      "notImplemented": "Не реализовано",
      "blocked": "Заблокировано",
      "allowed": "Разрешено",
      "denied": "Запрещено",
      "unavailable": "Недоступно",
      "requiresApproval": "Нужно одобрение"
    },
    "types": {
      "runtime": "Среда выполнения",
      "config": "Конфигурация",
      "orchestr": "Координация",
      "tool": "Инструмент",
      "article": "Статья",
      "secOps": "Операции безопасности"
    },
    "connectedServices": "Подключённые сервисы",
    "errorLoad": "Не удалось загрузить возможности",
    "integrations": {
      "kicker": "Проверенные интеграции продукта",
      "title": "Реализованные каналы сообщений",
      "manage": "Управление интеграциями",
      "sharedRuntime": "Общая среда выполнения NPATI Agent",
      "loading": "Загрузка статуса интеграций...",
      "notice": "Статус интеграций доступен при подключении Agent API."
    }
  },
  "activity": {
    "eyebrow": "Наблюдаемость и аудит",
    "title": "Активность и журнал запусков",
    "backAria": "Вернуться к настройкам",
    "heroCopy": "Подробная трассировка выполнения в реальном времени, этапы делегирования, вызовы инструментов, задержки и решения безопасности для запусков агентов компании.",
    "stats": {
      "totalRuns": "Всего запусков",
      "totalRunsDesc": "Записанные выполнения агентов",
      "completed": "Завершено",
      "completedDesc": "Успешно без ошибок",
      "inProgress": "В работе / В очереди",
      "inProgressDesc": "Активные задачи агентов",
      "securityDecisions": "Решения безопасности",
      "securityDecisionsDesc": "Проверенные вызовы инструментов"
    },
    "controls": {
      "companyLabel": "Компания:",
      "all": "Все",
      "completed": "Завершено",
      "running": "Выполняется",
      "failed": "Ошибка",
      "searchPlaceholder": "Поиск запусков по задаче или ID...",
      "searchAriaLabel": "Поиск запусков",
      "clearSearch": "Очистить поиск",
      "refresh": "Обновить",
      "refreshing": "Обновление...",
      "refreshTitle": "Обновить запуски"
    },
    "dispatch": {
      "title": "Отправить задачу агентам компании",
      "subtitle": "Запустите автономное выполнение задачи несколькими агентами и просматривайте трассировку в реальном времени",
      "modeLabel": "Режим выполнения:",
      "modes": {
        "auto": "Автокоординация (адаптивная)",
        "pipeline": "Конвейер (несколько агентов)",
        "single": "Один агент (быстро)",
        "fusion": "Объединение (несколько моделей)"
      },
      "placeholderWithCompany": "Введите задачу для агентов {{name}} (например, «Проанализируйте предложения и цены конкурентов»)...",
      "placeholderDefault": "Введите задание для агентов компании...",
      "dispatchTask": "Отправить задачу",
      "dispatching": "Отправка...",
      "presetsLabel": "Шаблоны:",
      "presets": {
        "marketAuditLabel": "Анализ рынка и конкурентов",
        "marketAuditPrompt": "Проведите всестороннее исследование конкурентов и анализ рыночного позиционирования",
        "securityAuditLabel": "Проверка безопасности и возможностей",
        "securityAuditPrompt": "Проверьте разрешения инструментов компании, правила доступа API и проверки безопасности",
        "growthRoadmapLabel": "Стратегический план роста",
        "growthRoadmapPrompt": "Составьте профиль идеального клиента и практический план роста на 90 дней"
      },
      "dispatchedNotice": "Запуск отправлен: {{id}} ({{status}})",
      "dispatchFailed": "Не удалось отправить запуск агента"
    },
    "empty": {
      "noCompaniesTitle": "Компании не найдены",
      "noCompaniesCopy": "Активность и журнал запусков отслеживают запуски нескольких агентов в контексте ИИ-компании.",
      "createCompanyBtn": "Создать ИИ-компанию",
      "noRunsTitle": "Запусков пока нет",
      "presetsTitle": "Шаблоны задач и начальные сценарии",
      "noRunsCopy": "У компании нет запусков агентов. Используйте форму выше или выберите шаблон, чтобы получить трассировку в реальном времени, этапы делегирования и аудит безопасности инструментов.",
      "presetsCopy": "Выберите шаблон ниже или введите свою задачу выше, чтобы получить трассировку, этапы делегирования и аудит безопасности инструментов.",
      "dispatchPresetBtn": "Отправить: {{label}} →",
      "viewTraceBtn": "История и трассировка выполнения ({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "Недавние выполнения ({{count}})",
      "backToPresets": "← 3 шаблона",
      "noFilteredRuns": "Нет запусков, соответствующих фильтрам.",
      "clearFiltersBtn": "Сбросить фильтры"
    },
    "trace": {
      "backToPresetsAria": "Вернуться к шаблонам",
      "modePrefix": "Режим: {{mode}}",
      "comboPrefix": "Комбинация: {{name}}",
      "runIdLabel": "ID запуска:",
      "copy": "Копировать",
      "copied": "Скопировано",
      "copyRunIdTitle": "Копировать ID запуска",
      "startedLabel": "Начат:",
      "completedLabel": "Завершён:",
      "durationLabel": "Длительность:",
      "finalOutput": "Итоговый результат",
      "copyResultTitle": "Копировать результат",
      "executionFault": "Ошибка выполнения",
      "completionReportTitle": "Отчёт о завершении фоновой задачи",
      "attemptSummary": "Попытка {{attempt}} · {{tokens}} токенов · ${{cost}} · {{duration}}с",
      "timelineTitle": "Хронология фонового выполнения ({{count}})",
      "timelineDesc": "Надёжные захваты задач обработчиками, повторы и события завершения",
      "attemptLabel": "Попытка {{attempt}}",
      "synchronousNotice": "Запуск выполнен синхронно; события фонового обработчика не создавались.",
      "delegationTitle": "Конвейер делегирования агентов ({{count}})",
      "delegationDesc": "Координация ролей и передача задач между агентами",
      "agentPrefix": "Агент: {{id}}",
      "modelPrefix": "Модель:",
      "lanePrefix": "Линия: {{lane}}",
      "noStepsNotice": "Для этой одношаговой задачи этапы делегирования не записаны.",
      "toolsTitle": "Вызовы инструментов и проверки безопасности ({{count}})",
      "toolsDesc": "Проверки канонического резолвера возможностей и аудит безопасности",
      "policyReason": "Причина политики:",
      "noToolsNotice": "Во время запуска внешние инструменты не вызывались.",
      "selectRunTitle": "Выберите запуск для просмотра",
      "selectRunCopy": "Выберите запуск слева для просмотра его хронологии, этапов делегирования и проверок безопасности."
    },
    "errors": {
      "loadRunsFailed": "Не удалось загрузить активность",
      "loadRunDetailsFailed": "Не удалось загрузить сведения о запуске"
    }
  },
  "automations": {
    "eyebrow": "Настройки · Автоматизации",
    "title": "Автоматизации и задачи по расписанию",
    "backAria": "Вернуться к настройкам",
    "heroCopy": "Настраивайте периодические фоновые события, регулярные задания cron и автономные задачи агентов компании.",
    "selectCompanyAria": "Выберите компанию",
    "newAutomationBtn": "+ Новая автоматизация",
    "stats": {
      "total": "всего автоматизаций",
      "totalDesc": "Фоновые задания ИИ по расписанию",
      "active": "активных триггеров",
      "activeDesc": "Действующие расписания cron",
      "paused": "приостановленных расписаний",
      "pausedDesc": "Ожидающие / неактивные триггеры",
      "assignedAgents": "назначенных агентов",
      "assignedAgentsDesc": "Настроенные исполнители-агенты"
    },
    "controls": {
      "searchPlaceholder": "Фильтр по названию, описанию, заданию, cron...",
      "searchAriaLabel": "Фильтр автоматизаций",
      "clearSearch": "Очистить поиск",
      "tabAll": "Все",
      "tabActive": "Активно",
      "tabPaused": "Приостановлено"
    },
    "showingStatus": "Показано автоматизаций: {{count}} из {{total}}",
    "matchingQuery": "по запросу «{{query}}»",
    "empty": {
      "noAutomationsTitle": "Автоматизации не настроены",
      "noAutomationsDesc": "Запланируйте для компании автономные фоновые задания cron, периодический анализ рынка или ежедневные рабочие процессы агентов.",
      "createFirstBtn": "+ Создать первую автоматизацию",
      "noMatchingTitle": "Подходящие автоматизации не найдены",
      "noMatchingDesc": "Измените поисковый запрос или фильтр статуса, чтобы найти нужное.",
      "clearFiltersBtn": "Сбросить фильтры"
    },
    "table": {
      "colStatus": "Статус",
      "colTask": "Задача и инструкции",
      "colSchedule": "Расписание (Cron)",
      "colAssignedAgent": "Назначенный агент",
      "colActions": "Действия",
      "statusActive": "АКТИВНО",
      "statusPaused": "ПАУЗА",
      "clickToPause": "Нажмите для приостановки",
      "clickToActivate": "Нажмите для активации",
      "promptPrefix": "Задание:",
      "nextRunPrefix": "Следующий запуск:",
      "mainAgent": "Главный агент",
      "runNow": "▶ Запустить сейчас",
      "running": "Выполнение...",
      "runNowTitle": "Запустить эту автоматизацию немедленно",
      "history": "История",
      "historyTitle": "Просмотреть историю запусков",
      "edit": "Изменить",
      "editTitle": "Изменить настройки автоматизации",
      "delete": "Удалить",
      "deleteTitle": "Удалить автоматизацию"
    },
    "presets": {
      "daily9": "Ежедневно в 09:00",
      "daily18": "Ежедневно в 18:00",
      "mondays9": "По понедельникам в 09:00",
      "fridays17": "По пятницам в 17:00",
      "hourly": "Каждый час",
      "daily0": "Ежедневно в 00:00"
    },
    "editor": {
      "kicker": "Автоматизации",
      "editTitle": "Изменить автоматизацию",
      "newTitle": "Новая автоматизация",
      "taskParamsHeading": "Параметры задачи",
      "taskNameLabel": "Название задачи",
      "taskNamePlaceholder": "Например, ежедневный анализ конкурентов",
      "descLabel": "Описание",
      "descPlaceholder": "Что выполняет эта автоматизация",
      "assignedAgentLabel": "Назначенный агент",
      "mainAgentDefault": "Главный агент (по умолчанию)",
      "schedulePresetsLabel": "Шаблоны расписания",
      "cronExpressionLabel": "Выражение cron (5 полей: минуты, часы, день, месяц, день недели)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "Задание агенту",
      "agentPromptPlaceholder": "Опишите точную цель и шаги, которые должен выполнить агент...",
      "saveBtn": "Сохранить автоматизацию",
      "savingBtn": "Сохранение...",
      "deleteBtn": "Удалить",
      "cancelBtn": "Отмена"
    },
    "history": {
      "kicker": "История запусков",
      "loading": "Загрузка истории запусков...",
      "noRuns": "Запусков пока не записано.",
      "duration": "Длительность:",
      "finalResult": "✓ Итоговый результат:",
      "error": "Ошибка:"
    },
    "dialogs": {
      "deleteTitle": "Удалить автоматизацию?",
      "deleteMessage": "Вы уверены, что хотите удалить эту автоматизацию?",
      "deleteConfirm": "Удалить",
      "deleteCancel": "Отмена"
    },
    "notifications": {
      "runInitiated": "Запуск «{{name}}» начат.",
      "resultReceived": "Результат получен!",
      "runError": "Ошибка запуска: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;

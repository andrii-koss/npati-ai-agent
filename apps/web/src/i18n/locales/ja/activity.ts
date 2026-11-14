import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "ガバナンスとセキュリティ",
    "title": "機能インスペクター",
    "backAria": "設定に戻る",
    "modelProfiles": {
      "title": "モデルプロファイル：保守的な代替設定。",
      "emptyHint": "このコンテキストではcode.model_profile.<id>フラグが有効になっていないため、モデルが{{count}} 件の登録済みプロファイルのいずれかに一致しても、すべての実行で保守的なプロファイル（ツール呼び出しは一度に1件、ツール呼び出し機能は自動検出）が使われます。段階的に導入するには、この環境で許可するプロファイルのフラグを有効にしてください。"
    },
    "heroCopy": "NPATI Agentの306の標準機能を調査・監査します。実際の実行環境でEffective Capability Resolverの境界、ツールの公開範囲、リスクポリシーを検証します。",
    "stats": {
      "totalLabel": "機能総数",
      "totalDesc": "検証済みの標準ID 1..306",
      "agentCallableLabel": "エージェントから呼び出し可能",
      "agentCallableDesc": "Resolver経由でモデルに公開",
      "runtimeOnlyLabel": "内部実行環境",
      "runtimeOnlyDesc": "隔離されたエンジン操作",
      "requiresApprovalLabel": "承認が必要",
      "requiresApprovalDesc": "人が介在するセキュリティゲート"
    },
    "slices": {
      "all": "すべて",
      "agentCallable": "エージェントから呼び出し可能",
      "runtimeOnly": "実行環境専用",
      "userVisible": "ユーザーに表示",
      "automatic": "自動",
      "allowed": "許可済み",
      "requiresApproval": "承認が必要"
    },
    "controls": {
      "searchPlaceholder": "名前、ID、分野で機能を絞り込み...",
      "searchAriaLabel": "機能を絞り込む",
      "clearSearch": "検索をクリア",
      "showing": "{{total}} 件中 {{start}}～{{end}} 件の機能を表示",
      "matching": "「{{term}}」に一致",
      "copied": "✓ {{id}}をコピーしました",
      "perPage": "1ページあたり：",
      "allCount": "すべて（{{total}} 件）"
    },
    "table": {
      "colId": "ID",
      "sortId": "IDで並べ替え",
      "colName": "名前",
      "sortName": "名前で並べ替え",
      "colCanonicalId": "標準ID",
      "sortCanonicalId": "標準IDで並べ替え",
      "colDomain": "分野",
      "sortDomain": "分野で並べ替え",
      "colType": "種類",
      "sortType": "種類で並べ替え",
      "colCallable": "呼び出し可否",
      "colRisk": "リスク",
      "sortRisk": "リスクで並べ替え",
      "colStatus": "状態",
      "sortStatus": "状態で並べ替え",
      "copyTooltip": "クリックして標準IDをコピー",
      "empty": "選択したフィルターに一致する機能がありません。",
      "prev": "← 前へ",
      "next": "次へ →"
    },
    "callable": {
      "callable": "呼び出し可否",
      "internal": "内部"
    },
    "risks": {
      "low": "低",
      "medium": "中",
      "high": "高",
      "critical": "重大"
    },
    "statuses": {
      "verified": "検証済み",
      "partial": "一部対応",
      "notImplemented": "未実装",
      "blocked": "ブロック済み",
      "allowed": "許可済み",
      "denied": "拒否済み",
      "unavailable": "利用不可",
      "requiresApproval": "要承認"
    },
    "types": {
      "runtime": "実行環境",
      "config": "設定",
      "orchestr": "統括",
      "tool": "ツール",
      "article": "記事",
      "secOps": "セキュリティ運用"
    },
    "connectedServices": "接続済みサービス",
    "errorLoad": "機能を読み込めませんでした",
    "integrations": {
      "kicker": "検証済みの製品連携",
      "title": "実装済みのメッセージングチャネル",
      "manage": "連携を管理",
      "sharedRuntime": "共有のNPATI Agent実行環境",
      "loading": "連携状態を読み込み中...",
      "notice": "Agent APIに接続すると、連携状態を確認できます。"
    }
  },
  "activity": {
    "eyebrow": "可観測性と監査",
    "title": "アクティビティと実行履歴",
    "backAria": "設定に戻る",
    "heroCopy": "会社エージェントの実行全体にわたり、リアルタイムの実行履歴、委任ステップ、ツール呼び出し、遅延、セキュリティ判断を詳しく確認できます。",
    "stats": {
      "totalRuns": "総実行数",
      "totalRunsDesc": "記録済みのエージェント実行",
      "completed": "完了",
      "completedDesc": "問題なく成功",
      "inProgress": "実行中 / キュー待機中",
      "inProgressDesc": "実行中のエージェント作業",
      "securityDecisions": "セキュリティ判断",
      "securityDecisionsDesc": "監査済みのツール確認"
    },
    "controls": {
      "companyLabel": "会社：",
      "all": "すべて",
      "completed": "完了",
      "running": "実行中",
      "failed": "失敗",
      "searchPlaceholder": "タスクまたはIDで実行を検索...",
      "searchAriaLabel": "実行を検索",
      "clearSearch": "検索をクリア",
      "refresh": "更新",
      "refreshing": "更新中...",
      "refreshTitle": "実行を更新"
    },
    "dispatch": {
      "title": "会社エージェントにタスクを送信",
      "subtitle": "自律的な複数エージェントのタスクを実行し、リアルタイムの履歴を確認します",
      "modeLabel": "実行モード：",
      "modes": {
        "auto": "自動統括（適応型）",
        "pipeline": "パイプライン（複数エージェント）",
        "single": "単一エージェント（高速）",
        "fusion": "融合（複数モデル）"
      },
      "placeholderWithCompany": "{{name}}のエージェントへのタスクを入力（例：「競合の提案と価格を分析する」）...",
      "placeholderDefault": "会社エージェントへのタスク指示を入力...",
      "dispatchTask": "タスクを送信",
      "dispatching": "送信中...",
      "presetsLabel": "プリセット：",
      "presets": {
        "marketAuditLabel": "市場と競合の調査",
        "marketAuditPrompt": "包括的な競合調査と市場での位置付け分析を行う",
        "securityAuditLabel": "セキュリティと機能の検証",
        "securityAuditPrompt": "会社のツール権限、APIアクセスルール、セキュリティゲートを監査する",
        "growthRoadmapLabel": "戦略的な成長計画",
        "growthRoadmapPrompt": "理想の顧客像と実行可能な90日間の成長計画をまとめる"
      },
      "dispatchedNotice": "実行を送信しました：{{id}}（{{status}}）",
      "dispatchFailed": "エージェント実行を送信できませんでした"
    },
    "empty": {
      "noCompaniesTitle": "会社が見つかりません",
      "noCompaniesCopy": "アクティビティと実行履歴では、AI会社のコンテキストで送信した複数エージェントの実行を追跡します。",
      "createCompanyBtn": "AI会社を作成",
      "noRunsTitle": "実行はまだ記録されていません",
      "presetsTitle": "タスクのプリセットと開始シナリオ",
      "noRunsCopy": "この会社には送信済みのエージェント実行がありません。上のタスク送信機能またはプリセットを使い、リアルタイムの履歴、委任ステップ、セキュリティ監査を生成してください。",
      "presetsCopy": "下のプリセットを選ぶか上で独自のタスクを入力して、リアルタイムの実行履歴、委任ステップ、セキュリティ監査を生成してください。",
      "dispatchPresetBtn": "送信：{{label}} →",
      "viewTraceBtn": "実行履歴と追跡を表示（{{count}}） →"
    },
    "sidebar": {
      "recentExecutions": "最近の実行（{{count}}）",
      "backToPresets": "← 3つのプリセット",
      "noFilteredRuns": "現在のフィルター条件に一致する実行がありません。",
      "clearFiltersBtn": "フィルターをクリア"
    },
    "trace": {
      "backToPresetsAria": "プリセットに戻る",
      "modePrefix": "モード：{{mode}}",
      "comboPrefix": "組み合わせ：{{name}}",
      "runIdLabel": "実行ID：",
      "copy": "コピー",
      "copied": "コピー済み",
      "copyRunIdTitle": "実行IDをコピー",
      "startedLabel": "開始：",
      "completedLabel": "完了：",
      "durationLabel": "所要時間：",
      "finalOutput": "最終出力結果",
      "copyResultTitle": "結果をコピー",
      "executionFault": "実行エラー",
      "completionReportTitle": "バックグラウンド完了レポート",
      "attemptSummary": "試行 {{attempt}} · {{tokens}} トークン · ${{cost}} · {{duration}}秒",
      "timelineTitle": "バックグラウンド実行のタイムライン（{{count}}）",
      "timelineDesc": "永続ワーカーの取得、再試行、終了イベント",
      "attemptLabel": "試行 {{attempt}}",
      "synchronousNotice": "この実行は同期処理のため、バックグラウンドワーカーのイベントは発生していません。",
      "delegationTitle": "エージェント委任パイプライン（{{count}}）",
      "delegationDesc": "複数エージェントの役割調整と引き継ぎ",
      "agentPrefix": "エージェント：{{id}}",
      "modelPrefix": "モデル：",
      "lanePrefix": "レーン：{{lane}}",
      "noStepsNotice": "この1ターンのタスクには委任ステップの記録がありません。",
      "toolsTitle": "ツール実行とセキュリティポリシーのゲート（{{count}}）",
      "toolsDesc": "標準機能リゾルバーの確認と安全性監査",
      "policyReason": "ポリシーの理由：",
      "noToolsNotice": "この実行では外部ツールの呼び出しはありませんでした。",
      "selectRunTitle": "確認する実行を選択",
      "selectRunCopy": "左パネルから実行を選択し、タイムライン、委任ステップ、セキュリティ監査を確認してください。"
    },
    "errors": {
      "loadRunsFailed": "アクティビティを読み込めませんでした",
      "loadRunDetailsFailed": "実行の詳細を読み込めませんでした"
    }
  },
  "automations": {
    "eyebrow": "設定 · 自動化",
    "title": "自動化と予約タスク",
    "backAria": "設定に戻る",
    "heroCopy": "会社の定期的なバックグラウンドトリガー、cronジョブ、自律エージェントタスクを設定します。",
    "selectCompanyAria": "会社を選択",
    "newAutomationBtn": "+ 新しい自動化",
    "stats": {
      "total": "自動化総数",
      "totalDesc": "予約済みのAIバックグラウンドジョブ",
      "active": "有効なトリガー",
      "activeDesc": "動作中のcronスケジュール",
      "paused": "一時停止中のスケジュール",
      "pausedDesc": "待機中 / 無効なトリガー",
      "assignedAgents": "割り当て済みのエージェント",
      "assignedAgentsDesc": "設定済みのエージェントランナー"
    },
    "controls": {
      "searchPlaceholder": "名前、説明、プロンプト、cronで自動化を絞り込み...",
      "searchAriaLabel": "自動化を絞り込む",
      "clearSearch": "検索をクリア",
      "tabAll": "すべて",
      "tabActive": "有効",
      "tabPaused": "一時停止"
    },
    "showingStatus": "{{total}} 件中 {{count}} 件の自動化を表示",
    "matchingQuery": "「{{query}}」に一致",
    "empty": {
      "noAutomationsTitle": "自動化は設定されていません",
      "noAutomationsDesc": "この会社の自律的なcronバックグラウンドタスク、定期的な市場調査、毎日のエージェントワークフローを設定します。",
      "createFirstBtn": "+ 最初の自動化を作成",
      "noMatchingTitle": "一致する自動化がありません",
      "noMatchingDesc": "検索語や状態フィルターを変更してお探しの項目を見つけてください。",
      "clearFiltersBtn": "フィルターをクリア"
    },
    "table": {
      "colStatus": "状態",
      "colTask": "タスクと指示",
      "colSchedule": "スケジュール（Cron）",
      "colAssignedAgent": "担当エージェント",
      "colActions": "操作",
      "statusActive": "有効",
      "statusPaused": "一時停止",
      "clickToPause": "クリックして一時停止",
      "clickToActivate": "クリックして有効化",
      "promptPrefix": "プロンプト：",
      "nextRunPrefix": "次回：",
      "mainAgent": "メインエージェント",
      "runNow": "▶ 今すぐ実行",
      "running": "実行中...",
      "runNowTitle": "この自動化を今すぐ実行",
      stop: "停止",
      stopTitle: "実行中の処理を停止",
      "history": "履歴",
      "historyTitle": "実行履歴を表示",
      "edit": "編集",
      "editTitle": "自動化設定を編集",
      "delete": "削除",
      "deleteTitle": "自動化を削除"
    },
    "presets": {
      "daily9": "毎日 09:00",
      "daily18": "毎日 18:00",
      "mondays9": "毎週月曜 09:00",
      "fridays17": "毎週金曜 17:00",
      "hourly": "毎時",
      "daily0": "毎日 00:00"
    },
    "editor": {
      "kicker": "自動化",
      "editTitle": "自動化を編集",
      "newTitle": "新しい自動化",
      "taskParamsHeading": "タスクのパラメーター",
      "taskNameLabel": "タスク名",
      "taskNamePlaceholder": "例：毎日の競合分析",
      "descLabel": "説明",
      "descPlaceholder": "この自動化が達成すること",
      "assignedAgentLabel": "担当エージェント",
      "mainAgentDefault": "メインエージェント（既定）",
      "schedulePresetsLabel": "スケジュールのプリセット",
      "cronExpressionLabel": "Cron式（5項目：分 時 日 月 曜日）",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "エージェントへのプロンプト",
      "agentPromptPlaceholder": "エージェントが実行する具体的な目標と手順を記述してください...",
      "saveBtn": "自動化を保存",
      "savingBtn": "保存中...",
      "deleteBtn": "削除",
      "cancelBtn": "キャンセル"
    },
    "history": {
      "kicker": "実行履歴",
      "loading": "実行履歴を読み込み中...",
      "noRuns": "実行はまだ記録されていません。",
      "duration": "所要時間：",
      "finalResult": "✓ 最終結果：",
      "error": "エラー："
    },
    "dialogs": {
      "deleteTitle": "自動化を削除しますか？",
      "deleteMessage": "この自動化を削除してもよろしいですか？",
      "deleteConfirm": "削除",
      "deleteCancel": "キャンセル"
    },
    "notifications": {
      "runInitiated": "「{{name}}」の実行を開始しました。",
      stopped: "「{{name}}」の実行を停止しました。",
      "resultReceived": "結果を受信しました！",
      "runError": "実行エラー：{{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;

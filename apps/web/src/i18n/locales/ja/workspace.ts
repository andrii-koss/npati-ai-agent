import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "設定 · 目標",
    "backToSettings": "設定に戻る",
    "title": "目標と達成項目",
    "heroCopy": "自律AIエージェントの方向性をそろえるために、測定可能な成果、数値目標、優先すべき節目を定義します。",
    "newGoal": "+ 新しい目標",
    "stats": {
      "totalGoals": "目標総数",
      "totalGoalsDesc": "定義済みのビジネス目標",
      "activeOutcomes": "進行中の成果",
      "activeOutcomesDesc": "進行中のエージェント優先事項",
      "completedGoals": "完了した目標",
      "completedGoalsDesc": "達成した節目",
      "highPriority": "高優先度",
      "highPriorityDesc": "重要なP1目標"
    },
    "searchPlaceholder": "タイトル、説明、指標の単位で目標を絞り込み...",
    "searchAria": "目標を絞り込む",
    "clearSearch": "検索をクリア",
    "tabs": {
      "all": "すべて",
      "active": "有効",
      "paused": "一時停止",
      "completed": "完了"
    },
    "filterByPriority": "優先度で絞り込む",
    "priorities": {
      "all": "すべての優先度",
      "high": "高優先度（P1）",
      "normal": "通常優先度（P2）",
      "low": "低優先度（P3）"
    },
    "priorityBadges": {
      "high": "高 P1",
      "normal": "通常 P2",
      "low": "低 P3"
    },
    "showingGoals": "{total} 件中 {count} 件の目標を表示",
    "matchingQuery": " 「{query}」に一致",
    "table": {
      "status": "状態",
      "goalAndOutcome": "目標と成果",
      "progress": "進捗",
      "priority": "優先度",
      "dueDate": "期限",
      "actions": "操作"
    },
    "statusTooltips": {
      "pause": "クリックして一時停止",
      "resume": "クリックして再開",
      "reactivate": "クリックして再有効化"
    },
    "statuses": {
      "active": "有効",
      "paused": "一時停止",
      "completed": "完了",
      "cancelled": "キャンセル済み"
    },
    "editGoalTooltip": "クリックして目標を編集",
    "qualitativeGoal": "定性的な目標",
    "overdue": "期限超過",
    "actions": {
      "done": "✓ 完了",
      "markCompleted": "目標を完了にする",
      "reopen": "再開",
      "reopenTitle": "目標を再開",
      "edit": "編集",
      "editTitle": "目標のパラメーターを編集",
      "delete": "削除",
      "deleteTitle": "目標を削除"
    },
    "empty": {
      "noGoalsTitle": "目標はまだ設定されていません",
      "noGoalsDesc": "NPATIエージェントが自律実行やチャットでの提案で優先できるよう、具体的な事業成果、数値目標、戦略的な節目を定義します。",
      "createFirstGoal": "+ 最初の目標を作成",
      "noMatchingTitle": "一致する目標がありません",
      "noMatchingDesc": "検索語やフィルターを変更してお探しの項目を見つけてください。",
      "clearFilters": "フィルターをクリア"
    },
    "drawer": {
      "kicker": "目標",
      "editGoal": "目標を編集",
      "newGoal": "新しい目標",
      "close": "閉じる",
      "objectiveSection": "目標の目的",
      "titleLabel": "目標のタイトル *",
      "titlePlaceholder": "例：最初の有料顧客100人を獲得",
      "descLabel": "説明 / 成功の基準",
      "descPlaceholder": "成功とはどのような状態ですか？エージェントが目指す具体的な成果は何ですか？",
      "priorityStatusSection": "優先度と状態",
      "priorityLabel": "優先度",
      "statusLabel": "状態",
      "metricSection": "指標の追跡（任意）",
      "metricHint": "定量的に測定・追跡できる目標には数値目標を指定してください。",
      "targetValueLabel": "目標値",
      "targetValuePlaceholder": "例：100",
      "currentValueLabel": "現在値",
      "currentValuePlaceholder": "例：42",
      "unitLabel": "単位",
      "unitPlaceholder": "例：ドル、ユーザー数、%",
      "dueDateSection": "達成予定日",
      "deadlineLabel": "節目の期限",
      "cancel": "キャンセル",
      "saving": "保存中...",
      "saveChanges": "目標の変更を保存",
      "createGoal": "目標を作成"
    },
    "notices": {
      "failedToLoad": "目標を読み込めませんでした：{message}",
      "titleRequired": "目標のタイトルが必要です",
      "updatedSuccess": "目標「{title}」を更新しました。",
      "createdSuccess": "目標「{title}」を作成しました。",
      "failedToSave": "目標を保存できませんでした：{message}",
      "deletedSuccess": "目標「{title}」を削除しました。",
      "failedToDelete": "目標を削除できませんでした：{message}",
      "statusUpdated": "目標「{title}」の状態を{status}に更新しました。",
      "statusUpdateError": "状態の更新エラー：{message}"
    },
    "dialogs": {
      "deleteTitle": "目標を削除しますか？",
      "deleteMessage": "目標「{title}」を削除してもよろしいですか？",
      "deleteConfirm": "削除",
      "deleteCancel": "キャンセル"
    }
  },
  "contentPage": {
    "eyebrow": "設定 · コンテンツハブ",
    "backToSettings": "設定に戻る",
    "title": "コンテンツハブと制作ライブラリ",
    "heroCopy": "自律エージェントが生成した記事、SEO計画、SNS下書きを確認、編集、整形、エクスポートします。",
    "newContentDraft": "+ 新しいコンテンツの下書き",
    "newContentPrompt": "対象顧客層に向けて効果的なマーケティング記事とSNS配信計画の下書きを作成してください。",
    "tabs": {
      "all": "すべての項目",
      "articles": "記事",
      "seoBlueprints": "SEO計画",
      "socialPosts": "SNS投稿",
      "briefsPlans": "概要と計画"
    },
    "searchPlaceholder": "下書き、キーワード、トピックを検索...",
    "searchAria": "コンテンツライブラリを検索",
    "clearSearch": "検索をクリア",
    "types": {
      "article": "記事",
      "seoBlueprint": "SEO計画",
      "socialMedia": "ソーシャルメディア",
      "briefPlan": "概要と計画"
    },
    "empty": {
      "readyTitle": "AIコンテンツライブラリの準備ができました",
      "readyDesc": "会社の自律エージェントがコンテンツ概要、キーワード調査、記事作成を実行すると、生成した制作下書きがすべてここに整理されます。",
      "generateFirstDraft": "+ チャットで最初の下書きを生成",
      "chatPrompt": "理想の顧客像に合わせ、要点とFAQを含むSEOブログ記事の下書きを作成してください。",
      "restoreDeleted": "削除したドキュメントを復元",
      "noMatchingTitle": "一致するドキュメントがありません",
      "noMatchingDesc": "検索語を変更するか、別のコンテンツ種別フィルターを選択してください。",
      "resetFilters": "フィルターをリセット",
      "selectDoc": "左側からドキュメントを選択して、閲覧またはエクスポートしてください。"
    },
    "cards": {
      "listAria": "生成されたドキュメント一覧",
      "deleteDocumentTitle": "ドキュメントを削除",
      "minRead": "約{count}分で読めます"
    },
    "viewer": {
      "expand": "展開",
      "collapse": "折りたたむ",
      "expandTitle": "展開してドキュメント全体を読む",
      "collapseTitle": "標準表示に戻す",
      "editDocument": "ドキュメントを編集",
      "views": {
        "preview": "プレビュー",
        "previewTitle": "書式付きの閲覧表示",
        "raw": "元の.md",
        "rawTitle": "元のMarkdownソース"
      },
      "actions": {
        "edit": "✎ 編集",
        "editTitle": "ドキュメントの本文、タイトル、カテゴリを編集",
        "delete": "🗑 削除",
        "deleteTitle": "このドキュメントを削除",
        "copy": "コピー",
        "copied": "✓ コピーしました！",
        "copyTitle": "Markdownの内容をクリップボードにコピー",
        "download": ".mdをダウンロード",
        "downloadTitle": "Markdownファイルとしてダウンロード",
        "saveChanges": "✓ 変更を保存",
        "saveChangesTitle": "変更を保存",
        "cancel": "キャンセル",
        "cancelTitle": "編集をキャンセル"
      },
      "metrics": {
        "words": "単語",
        "characters": "文字",
        "readTime": "読了時間",
        "generatedDate": "生成日"
      },
      "editor": {
        "titleLabel": "ドキュメントのタイトル",
        "titlePlaceholder": "ドキュメントのタイトルを入力...",
        "typeLabel": "コンテンツの種類",
        "bodyLabel": "ドキュメント本文（Markdown）",
        "saveHint": "Ctrl+Sで保存",
        "bodyPlaceholder": "ここでMarkdownの本文を作成・編集してください..."
      },
      "overlay": {
        "expand": "展開してドキュメント全体を読む",
        "collapse": "標準表示に戻す"
      }
    },
    "toast": {
      "saved": "変更を保存しました！",
      "saveError": "変更を保存できませんでした",
      "deleted": "ドキュメントを削除しました",
      "deleteError": "ドキュメントを削除できませんでした"
    },
    "dialogs": {
      "deleteTitle": "コンテンツを削除しますか？",
      "deleteMessage": "「{title}」を削除してもよろしいですか？",
      "deleteConfirm": "削除",
      "deleteCancel": "キャンセル",
      "thisDocumentFallback": "このドキュメント"
    }
  },
  "connectionsPage": {
    "eyebrow": "インフラと連携",
    "backToSettings": "設定に戻る",
    "title": "接続済みサービス",
    "heroCopy": "すべてのストレージエンジン、内部AIアダプター、システムマイクロサービスの稼働状況、エンドポイント、状態を監視します。",
    "refreshStatus": "状態を更新",
    "checkingStatus": "状態を確認中...",
    "refreshTitle": "サービスのヘルスチェック用エンドポイントを確認",
    "lastSuccessfulCheck": "最後に確認できた時刻：{{time}}",
    "noSuccessfulCheck": "確認に成功した記録はありません",
    "checkFailed": "稼働状況の確認に失敗しました。サービスを利用できません",
    "searchPlaceholder": "名前、エンドポイント、カテゴリでサービスを絞り込み...",
    "searchAria": "接続済みサービスを絞り込む",
    "clearSearch": "検索をクリア",
    "tabs": {
      "all": "すべて",
      "internal": "内部",
      "storage": "ストレージ",
      "provider": "プロバイダー",
      "operational": "稼働中"
    },
    "categories": {
      "internal": "内部エンジン",
      "storage": "データストレージ",
      "provider": "クラウドプロバイダー"
    },
    "statuses": {
      "operational": "稼働中",
      "standby": "待機",
      "degraded": "性能低下",
      "down": "停止"
    },
    "empty": {
      "title": "一致するサービスがありません",
      "description": "検索語を変更するか、別のカテゴリを選択してください。",
      "resetFilters": "フィルターをリセット"
    },
    "card": {
      "copy": "コピー",
      "copied": "✓ コピー済み",
      "copyTitle": "接続文字列をコピー",
      "verifiedFallback": "Dockerネットワーク内で検証済み",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATIのAIルーティング",
        "desc": "A2A統括、組み合わせルーティング、融合、パイプライン、埋め込みエンジン（v3.8.52）。",
        "details": "v3.8.52コア",
        "versionPrefix": "バージョン"
      },
      "postgres": {
        "name": "pgvector搭載PostgreSQL",
        "desc": "ワークスペース、会社、ナレッジのチャンク、ベクトル埋め込みの一元的な情報源。",
        "details": "ベクトル拡張が有効"
      },
      "redis": {
        "name": "Redisキャッシュとストリーム",
        "desc": "非同期タスクキュー、リース、分散ロック、会話メモリのキャッシュ。",
        "details": "メモリ内キャッシュが有効"
      },
      "minio": {
        "name": "MinIO S3ストレージ",
        "desc": "会社ナレッジの添付ファイルとバイナリアセットをテナントごとに分離して保存。",
        "details": "S3互換API"
      },
      "crawler": {
        "name": "Crawl4AIウェブクローラー",
        "desc": "詳細なウェブ調査クローラー、Markdown変換、SSRレンダリングエンジン。",
        "details": "ヘッドレスワーカープール"
      },
      "coreBackend": {
        "name": "NPATIコアバックエンド",
        "desc": "認証、ユーザーアカウント、請求の一元的な情報源。",
        "details": "APIゲートウェイが有効"
      },
      "cloudHub": {
        "name": "NPATIクラウドハブ",
        "desc": "任意のクラウドカタログ同期と共有モデルレジストリ。",
        "details": "ローカル展開では任意"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "ビジネス情報とナレッジ",
    "backToSettings": "設定に戻る",
    "title": "ビジネスメモリ",
    "heroCopy": "NPATI Agentがすべてのチャットやタスクで使う永続的な事実、検証済みの顧客像、ブランド表現のルール、戦略的な決定を整理します。",
    "addFactBtn": "+ メモリ情報を追加",
    "addFactTitle": "新しいビジネス情報や決定事項を追加",
    "searchPlaceholder": "キーワード、タイトル、内容、出典でメモリを検索...",
    "searchAria": "メモリ項目を絞り込む",
    "clearSearch": "検索をクリア",
    "tabs": {
      "all": "すべての項目",
      "facts": "ビジネス情報",
      "audience": "顧客層と理想の顧客像",
      "brand": "ブランドと表現",
      "decisions": "決定事項と戦略",
      "product": "商品とサービス",
      "other": "その他"
    },
    "types": {
      "business_fact": "ビジネスの事実",
      "audience": "顧客層と理想の顧客像",
      "brand": "ブランドと表現",
      "decision": "戦略的決定",
      "product": "商品とサービス",
      "channel": "マーケティングチャネル",
      "preference": "ユーザーの好み",
      "experiment": "実験",
      "result": "結果と指標",
      "other": "その他のナレッジ"
    },
    "sources": {
      "manual": "手動",
      "chatConfirmed": "チャットで確認済み",
      "onboarding": "初期設定",
      "userVerified": "ユーザー検証済み",
      "sourcePrefix": "出典"
    },
    "empty": {
      "title": "永続メモリ項目はまだありません",
      "description": "ビジネスの基本情報、対象顧客層、ブランドのトーン、合意した決定事項を追加してください。NPATI Agentはチャットで推論するときにこれらを自動で思い出し、事実を作りません。",
      "addFirstBtn": "+ 最初の情報を追加"
    },
    "emptyFiltered": {
      "title": "一致するメモリがありません",
      "description": "検索語を変更するか、カテゴリフィルターを切り替えてください。",
      "resetFilters": "フィルターをリセット"
    },
    "card": {
      "verified": "✓ 検証済み",
      "confidenceTooltip": "確信度スコア：{score}",
      "copy": "コピー",
      "copied": "✓ コピー済み",
      "copyTitle": "情報の内容をコピー",
      "edit": "編集",
      "editTitle": "このメモリ情報を編集",
      "delete": "削除",
      "deleteTitle": "このメモリ情報を削除",
      "deleteFactTitle": "メモリ情報を削除"
    },
    "drawer": {
      "eyebrow": "ビジネスナレッジ",
      "editTitle": "メモリ情報を編集",
      "newTitle": "新しいメモリ情報",
      "closeAria": "閉じる",
      "categorySection": "カテゴリと分類",
      "typeLabel": "メモリの種類 *",
      "types": {
        "businessFact": "📌 ビジネスの事実（運用ルール、価格、事実）",
        "audience": "🎯 対象顧客層と理想の顧客像（ペルソナ、属性、課題）",
        "brand": "✨ ブランドと表現（トーン、語り口、位置付けのルール）",
        "decision": "⚖️ 戦略的決定（確認済みの計画、選択）",
        "product": "📦 商品とサービス（提供内容、仕様、機能）",
        "channel": "📢 マーケティングチャネル（配信、プラットフォーム）",
        "preference": "⚙️ ユーザーの好み（形式、プロンプトの指示）",
        "experiment": "🧪 実験（成長テスト、検証中の仮説）",
        "result": "📈 結果と指標（成果、検証済みの発見）",
        "other": "📝 その他のナレッジ"
      },
      "detailsSection": "メモリの詳細",
      "titleLabel": "タイトル *",
      "titlePlaceholder": "例：主要対象顧客：欧州のB2B創業者",
      "contentLabel": "事実の内容 / 指針 *",
      "contentPlaceholder": "NPATI Agentが従うべき検証済みの事実、数値、制約、ルールを詳しく記述してください...",
      "confidenceSection": "確信度",
      "confidenceLabel": "検証レベル",
      "confidenceOptions": {
        "high100": "検証済みの事実（100% - 確実なルール）",
        "med80": "高い確信度（80% - 十分な観察）",
        "low50": "仮説（50% - 調査中）"
      },
      "cancel": "キャンセル",
      "saving": "情報を保存中...",
      "saveChanges": "変更を保存",
      "saveFact": "メモリ情報を保存",
      "errors": {
        "titleRequired": "タイトルが必要です",
        "contentRequired": "事実の内容の説明が必要です",
        "saveFailed": "メモリ項目を保存できませんでした"
      },
      "defaultBusinessName": "マイビジネス"
    },
    "toasts": {
      "copied": "メモリ情報をクリップボードにコピーしました",
      "updated": "メモリ項目を更新しました",
      "saved": "新しいメモリ項目を保存しました",
      "deleted": "削除しました：「{title}」",
      "deleteError": "メモリ項目を削除できませんでした"
    },
    "dialogs": {
      "deleteTitle": "メモリの情報を削除しますか？",
      "deleteMessage": "メモリ項目「{title}」を削除しますか？この操作は元に戻せません。",
      "deleteConfirm": "削除",
      "deleteCancel": "キャンセル"
    }
  },
  "skillsPage": {
    "eyebrow": "設定 · スキル",
    "backToSettings": "設定に戻る",
    "title": "エージェントのスキル",
    "heroCopy": "NPATI Agentが依頼に応じて自動選択する組み込みのビジネス機能を閲覧します。",
    "badgeBuiltin": "組み込みカタログ",
    "stats": {
      "availableSkills": "利用可能なスキル",
      "availableSkillsDesc": "登録済みのエージェントワークフロー",
      "capabilities": "機能",
      "capabilitiesDesc": "エージェントが利用できる操作",
      "autoValue": "自動",
      "skillSelection": "スキルの選択",
      "skillSelectionDesc": "依頼とコンテキストに合わせて選択"
    },
    "searchPlaceholder": "スキルと機能を検索...",
    "searchAria": "スキルを絞り込む",
    "clearSearch": "検索をクリア",
    "statusShowing": {
      "showing": "表示中",
      "of": "/ ",
      "skills": "スキル"
    },
    "errorLoading": "スキルを読み込めませんでした",
    "empty": {
      "title": "一致するスキルがありません",
      "description": "別の名前、説明、機能をお試しください。",
      "clearSearch": "検索をクリア"
    },
    "card": {
      "available": "利用可能",
      "builtinType": "組み込みスキル"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "競合分析",
        "desc": "関連する競合を見つけ、公開情報を現在のビジネス情報と比較します。"
      },
      "webResearch": {
        "name": "ウェブ調査",
        "desc": "保護されたNPATI Web Researchの範囲で公開ウェブ情報を検索・閲覧します。"
      },
      "businessStartup": {
        "name": "ビジネス立ち上げ",
        "desc": "ビジネスアイデア、顧客層、提案、最初の検証計画を具体化します。"
      },
      "businessGrowth": {
        "name": "ビジネス成長",
        "desc": "顧客獲得、維持、位置付け、成長の実践的な機会を見つけます。"
      },
      "sellProduct": {
        "name": "商品を販売",
        "desc": "商品やサービスを明確な提案と販売計画にまとめます。"
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;

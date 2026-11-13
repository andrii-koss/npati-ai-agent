import type { TranslationSchema } from "../../types";

export const workspace = {
  "goalsPage": {
    "eyebrow": "설정 · 목표",
    "backToSettings": "설정으로 돌아가기",
    "title": "목표 및 목적",
    "heroCopy": "자율 AI 에이전트의 방향을 맞추기 위해 측정 가능한 성과, 지표 목표 및 우선 이정표를 정의하세요.",
    "newGoal": "+ 새 목표",
    "stats": {
      "totalGoals": "전체 목표",
      "totalGoalsDesc": "정의된 비즈니스 목표",
      "activeOutcomes": "진행 중인 성과",
      "activeOutcomesDesc": "진행 중인 에이전트 우선순위",
      "completedGoals": "완료된 목표",
      "completedGoalsDesc": "달성한 이정표",
      "highPriority": "높은 우선순위",
      "highPriorityDesc": "중요 P1 목표"
    },
    "searchPlaceholder": "제목, 설명 또는 지표 단위로 목표 필터링...",
    "searchAria": "목표 필터링",
    "clearSearch": "검색 지우기",
    "tabs": {
      "all": "전체",
      "active": "활성",
      "paused": "일시 중지",
      "completed": "완료"
    },
    "filterByPriority": "우선순위별 필터링",
    "priorities": {
      "all": "모든 우선순위",
      "high": "높은 우선순위(P1)",
      "normal": "보통 우선순위(P2)",
      "low": "낮은 우선순위(P3)"
    },
    "priorityBadges": {
      "high": "높음 P1",
      "normal": "보통 P2",
      "low": "낮음 P3"
    },
    "showingGoals": "목표 {total}개 중 {count}개 표시",
    assignedAgent: "담당 에이전트",
    "matchingQuery": " \"{query}\"과 일치",
    "table": {
      "status": "상태",
      "goalAndOutcome": "목표 및 성과",
      "progress": "진행률",
      "priority": "우선순위",
      "dueDate": "기한",
      "actions": "작업"
    },
    "statusTooltips": {
      "pause": "클릭하여 일시 중지",
      "resume": "클릭하여 재개",
      "reactivate": "클릭하여 다시 활성화"
    },
    "statuses": {
      "active": "활성",
      "paused": "일시 중지",
      "completed": "완료",
      "cancelled": "취소됨"
    },
    "editGoalTooltip": "클릭하여 목표 수정",
    "qualitativeGoal": "정성적 목표",
    "overdue": "기한 초과",
    "actions": {
      "done": "✓ 완료",
      "markCompleted": "목표를 완료로 표시",
      "reopen": "다시 열기",
      "reopenTitle": "목표 다시 열기",
      "edit": "수정",
      "editTitle": "목표 매개변수 수정",
      "delete": "삭제",
      "deleteTitle": "목표 삭제"
    },
    "empty": {
      "noGoalsTitle": "설정된 목표가 아직 없습니다",
      "noGoalsDesc": "NPATI 에이전트가 자율 실행과 채팅 추천에서 우선하도록 구체적인 비즈니스 성과, 지표 목표 또는 전략적 이정표를 정의하세요.",
      "createFirstGoal": "+ 첫 목표 만들기",
      "noMatchingTitle": "일치하는 목표 없음",
      "noMatchingDesc": "검색어나 필터 선택을 조정하여 원하는 항목을 찾아보세요.",
      "clearFilters": "필터 지우기"
    },
    "drawer": {
      "kicker": "목표",
      "editGoal": "목표 수정",
      "newGoal": "새 목표",
      "close": "닫기",
      "objectiveSection": "목표 목적",
      "titleLabel": "목표 제목 *",
      "titlePlaceholder": "예: 첫 유료 고객 100명 확보",
      "descLabel": "설명 / 성공 기준",
      "descPlaceholder": "성공은 어떤 모습인가요? 에이전트가 달성해야 할 구체적인 성과는 무엇인가요?",
      "priorityStatusSection": "우선순위 및 상태",
      "priorityLabel": "우선순위",
      "statusLabel": "상태",
      "metricSection": "지표 추적(선택 사항)",
      "metricHint": "이 목표를 정량적으로 측정하고 추적할 수 있다면 수치 목표를 지정하세요.",
      "targetValueLabel": "목표값",
      "targetValuePlaceholder": "예: 100",
      "currentValueLabel": "현재값",
      "currentValuePlaceholder": "예: 42",
      "unitLabel": "단위",
      "unitPlaceholder": "예: 달러, 사용자, %",
      "dueDateSection": "목표 기한",
      "deadlineLabel": "이정표 마감일",
      "cancel": "취소",
      "saving": "저장 중...",
      "saveChanges": "목표 변경 사항 저장",
      "createGoal": "목표 만들기"
    },
    "notices": {
      "failedToLoad": "목표를 불러오지 못했습니다: {message}",
      "titleRequired": "목표 제목이 필요합니다",
      "updatedSuccess": "목표 \"{title}\"을 업데이트했습니다.",
      "createdSuccess": "목표 \"{title}\"을 만들었습니다.",
      "failedToSave": "목표를 저장하지 못했습니다: {message}",
      "deletedSuccess": "목표 \"{title}\"을 삭제했습니다.",
      "failedToDelete": "목표를 삭제하지 못했습니다: {message}",
      "statusUpdated": "목표 \"{title}\"의 상태를 {status}(으)로 업데이트했습니다.",
      "statusUpdateError": "상태 업데이트 오류: {message}"
    },
    "dialogs": {
      "deleteTitle": "목표를 삭제하시겠습니까?",
      "deleteMessage": "목표 \"{title}\"을 삭제하시겠습니까?",
      "deleteConfirm": "삭제",
      "deleteCancel": "취소"
    }
  },
  "contentPage": {
    "eyebrow": "설정 · 콘텐츠 허브",
    "backToSettings": "설정으로 돌아가기",
    "title": "콘텐츠 허브 및 제작 라이브러리",
    "heroCopy": "자율 에이전트가 생성한 기사, SEO 계획 및 소셜 초안을 검토, 수정, 서식 지정 및 내보내기합니다.",
    "newContentDraft": "+ 새 콘텐츠 초안",
    "newContentPrompt": "대상 고객층을 위한 효과적인 마케팅 기사 및 소셜 배포 계획 초안을 작성하세요.",
    "tabs": {
      "all": "모든 항목",
      "articles": "기사",
      "seoBlueprints": "SEO 계획",
      "socialPosts": "소셜 게시물",
      "briefsPlans": "개요 및 계획"
    },
    "searchPlaceholder": "초안, 키워드, 주제 검색...",
    "searchAria": "콘텐츠 라이브러리 검색",
    "clearSearch": "검색 지우기",
    "types": {
      "article": "기사",
      "seoBlueprint": "SEO 계획",
      "socialMedia": "소셜 미디어",
      "briefPlan": "개요 및 계획"
    },
    "empty": {
      "readyTitle": "AI 콘텐츠 라이브러리가 준비되었습니다",
      "readyDesc": "회사 자율 에이전트가 콘텐츠 개요, 키워드 조사 또는 기사 작성 작업을 수행하면 생성된 모든 제작 초안이 여기에 정리됩니다.",
      "generateFirstDraft": "+ 채팅에서 첫 초안 생성",
      "chatPrompt": "이상적인 고객 프로필을 대상으로 핵심 요점과 FAQ가 포함된 SEO 블로그 게시물 초안을 작성하세요.",
      "restoreDeleted": "삭제된 문서 복원",
      "noMatchingTitle": "일치하는 문서 없음",
      "noMatchingDesc": "검색어를 조정하거나 다른 콘텐츠 유형 필터를 선택하세요.",
      "resetFilters": "필터 초기화",
      "selectDoc": "왼쪽에서 문서를 선택하여 읽거나 내보내세요."
    },
    "cards": {
      "listAria": "생성된 문서 목록",
      "deleteDocumentTitle": "문서 삭제",
      "minRead": "약 {count}분 분량"
    },
    "viewer": {
      "expand": "펼치기",
      "collapse": "접기",
      "expandTitle": "펼쳐서 전체 문서 읽기",
      "collapseTitle": "기본 보기로 접기",
      "editDocument": "문서 수정",
      "views": {
        "preview": "미리보기",
        "previewTitle": "서식이 적용된 읽기 화면",
        "raw": "원본 .md",
        "rawTitle": "원본 Markdown 소스"
      },
      "actions": {
        "edit": "✎ 수정",
        "editTitle": "문서 본문, 제목 및 범주 수정",
        "delete": "🗑 삭제",
        "deleteTitle": "이 문서 삭제",
        "copy": "복사",
        "copied": "✓ 복사했습니다!",
        "copyTitle": "Markdown 내용을 클립보드에 복사",
        "download": ".md 다운로드",
        "downloadTitle": "Markdown 파일로 다운로드",
        "saveChanges": "✓ 변경 사항 저장",
        "saveChangesTitle": "변경 사항 저장",
        "cancel": "취소",
        "cancelTitle": "수정 취소"
      },
      "metrics": {
        "words": "단어",
        "characters": "문자",
        "readTime": "읽기 시간",
        "generatedDate": "생성 날짜"
      },
      "editor": {
        "titleLabel": "문서 제목",
        "titlePlaceholder": "문서 제목 입력...",
        "typeLabel": "콘텐츠 유형",
        "bodyLabel": "문서 본문(Markdown)",
        "saveHint": "Ctrl+S를 눌러 저장",
        "bodyPlaceholder": "여기에서 Markdown 문서 본문을 작성하거나 수정하세요..."
      },
      "overlay": {
        "expand": "펼쳐서 전체 문서 읽기",
        "collapse": "기본 보기로 접기"
      }
    },
    "toast": {
      "saved": "변경 사항을 저장했습니다!",
      "saveError": "변경 사항을 저장하지 못했습니다",
      "deleted": "문서를 삭제했습니다",
      "deleteError": "문서를 삭제하지 못했습니다"
    },
    "dialogs": {
      "deleteTitle": "콘텐츠를 삭제하시겠습니까?",
      "deleteMessage": "\"{title}\"을 삭제하시겠습니까?",
      "deleteConfirm": "삭제",
      "deleteCancel": "취소",
      "thisDocumentFallback": "이 문서"
    }
  },
  "connectionsPage": {
    "eyebrow": "인프라 및 통합",
    "backToSettings": "설정으로 돌아가기",
    "title": "연결된 서비스",
    "heroCopy": "모든 저장소 엔진, 내부 AI 어댑터 및 시스템 마이크로서비스의 실행 상태, 엔드포인트 및 상태를 모니터링합니다.",
    "refreshStatus": "상태 새로고침",
    "checkingStatus": "상태 확인 중...",
    "refreshTitle": "서비스 상태 엔드포인트 검사",
    "lastSuccessfulCheck": "마지막 성공 확인: {{time}}",
    "noSuccessfulCheck": "아직 성공한 확인이 없습니다",
    "checkFailed": "상태 확인 실패 — 서비스를 사용할 수 없습니다",
    "searchPlaceholder": "이름, 엔드포인트 또는 범주로 서비스 필터링...",
    "searchAria": "연결된 서비스 필터링",
    "clearSearch": "검색 지우기",
    "tabs": {
      "all": "전체",
      "internal": "내부",
      "storage": "저장소",
      "provider": "제공업체",
      "operational": "정상 작동"
    },
    "categories": {
      "internal": "내부 엔진",
      "storage": "데이터 저장소",
      "provider": "클라우드 제공업체"
    },
    "statuses": {
      "operational": "정상 작동",
      "standby": "대기",
      "degraded": "성능 저하",
      "down": "중단"
    },
    "empty": {
      "title": "일치하는 서비스 없음",
      "description": "검색어를 조정하거나 다른 범주 필터를 선택하세요.",
      "resetFilters": "필터 초기화"
    },
    "card": {
      "copy": "복사",
      "copied": "✓ 복사됨",
      "copyTitle": "연결 문자열 복사",
      "verifiedFallback": "Docker 네트워크에서 검증됨",
      "protocol": "HTTP / TCP"
    },
    "services": {
      "omniroute": {
        "name": "NPATI AI 라우팅",
        "desc": "A2A 조율, 조합 라우팅, 융합, 파이프라인 및 임베딩 엔진(v3.8.52).",
        "details": "v3.8.52 코어",
        "versionPrefix": "버전"
      },
      "postgres": {
        "name": "pgvector가 포함된 PostgreSQL",
        "desc": "작업 공간, 회사, 지식 청크 및 벡터 임베딩을 위한 단일 기준 데이터 저장소.",
        "details": "벡터 확장 활성"
      },
      "redis": {
        "name": "Redis 캐시 및 스트림",
        "desc": "비동기 작업 대기열, 임대, 분산 잠금 및 대화 메모리 캐싱.",
        "details": "인메모리 캐시 활성"
      },
      "minio": {
        "name": "MinIO S3 저장소",
        "desc": "회사 지식 첨부 파일 및 바이너리 자산을 위한 테넌트별 격리 문서 저장소.",
        "details": "S3 호환 API"
      },
      "crawler": {
        "name": "Crawl4AI 웹 크롤러",
        "desc": "심층 웹 조사 크롤러, Markdown 변환 및 SSR 렌더링 엔진.",
        "details": "헤드리스 작업자 풀"
      },
      "coreBackend": {
        "name": "NPATI 핵심 백엔드",
        "desc": "인증, 사용자 계정 및 청구를 위한 단일 기준 데이터 저장소.",
        "details": "API 게이트웨이 활성"
      },
      "cloudHub": {
        "name": "NPATI 클라우드 허브",
        "desc": "선택적인 클라우드 카탈로그 동기화 및 공유 모델 레지스트리.",
        "details": "로컬 배포 시 선택 사항"
      }
    }
  },
  "memoryPage": {
    "eyebrow": "비즈니스 맥락 및 지식",
    "backToSettings": "설정으로 돌아가기",
    "title": "비즈니스 메모리",
    "heroCopy": "NPATI Agent가 모든 채팅과 작업에서 활용하는 지속 정보, 검증된 고객 프로필, 브랜드 표현 규칙 및 전략적 결정을 관리하세요.",
    "addFactBtn": "+ 메모리 정보 추가",
    "addFactTitle": "새 비즈니스 정보 또는 결정 추가",
    "searchPlaceholder": "키워드, 제목, 정보 내용 또는 출처로 메모리 검색...",
    "searchAria": "메모리 항목 필터링",
    "clearSearch": "검색 지우기",
    "tabs": {
      "all": "모든 항목",
      "facts": "비즈니스 정보",
      "audience": "고객층 및 이상적인 고객 프로필",
      "brand": "브랜드 및 표현",
      "decisions": "결정 및 전략",
      "product": "제품 및 서비스",
      "other": "기타"
    },
    "types": {
      "business_fact": "비즈니스 정보",
      "audience": "고객층 및 이상적인 고객 프로필",
      "brand": "브랜드 및 표현",
      "decision": "전략적 결정",
      "product": "제품 및 서비스",
      "channel": "마케팅 채널",
      "preference": "사용자 선호도",
      "experiment": "실험",
      "result": "결과 및 지표",
      "other": "기타 지식"
    },
    "sources": {
      "manual": "수동",
      "chatConfirmed": "채팅에서 확인됨",
      "onboarding": "온보딩",
      "userVerified": "사용자 확인됨",
      "sourcePrefix": "출처"
    },
    "empty": {
      "title": "영구 메모리 항목이 아직 없습니다",
      "description": "비즈니스 핵심 정보, 대상 고객층, 브랜드 어조 또는 합의된 결정을 추가하세요. NPATI Agent는 채팅 추론 시 이를 자동으로 참고하며 없는 사실을 만들어 내지 않습니다.",
      "addFirstBtn": "+ 첫 정보 추가"
    },
    "emptyFiltered": {
      "title": "일치하는 메모리 없음",
      "description": "검색 키워드를 조정하거나 범주 필터를 변경하세요.",
      "resetFilters": "필터 초기화"
    },
    "card": {
      "verified": "✓ 검증됨",
      "confidenceTooltip": "신뢰도 점수: {score}",
      "copy": "복사",
      "copied": "✓ 복사됨",
      "copyTitle": "정보 내용 복사",
      "edit": "수정",
      "editTitle": "이 메모리 정보 수정",
      "delete": "삭제",
      "deleteTitle": "이 메모리 정보 삭제",
      "deleteFactTitle": "메모리 정보 삭제"
    },
    "drawer": {
      "eyebrow": "비즈니스 지식",
      "editTitle": "메모리 정보 수정",
      "newTitle": "새 메모리 정보",
      "closeAria": "닫기",
      "categorySection": "범주 및 분류",
      "typeLabel": "메모리 유형 *",
      "types": {
        "businessFact": "📌 비즈니스 정보(운영 규칙, 가격, 사실)",
        "audience": "🎯 대상 고객층 및 이상적인 고객 프로필(페르소나, 인구 통계, 어려움)",
        "brand": "✨ 브랜드 및 표현(어조, 표현, 포지셔닝 규칙)",
        "decision": "⚖️ 전략적 결정(확정된 로드맵, 선택)",
        "product": "📦 제품 및 서비스(제공 항목, 사양, 기능)",
        "channel": "📢 마케팅 채널(배포, 플랫폼)",
        "preference": "⚙️ 사용자 선호도(형식, 프롬프트 지침)",
        "experiment": "🧪 실험(성장 테스트, 진행 중인 가설)",
        "result": "📈 결과 및 지표(성과, 검증된 발견)",
        "other": "📝 기타 지식"
      },
      "detailsSection": "메모리 세부 정보",
      "titleLabel": "제목 *",
      "titlePlaceholder": "예: 주요 대상 고객: 유럽의 B2B 창업자",
      "contentLabel": "정보 내용 / 지침 *",
      "contentPlaceholder": "NPATI Agent가 준수해야 할 검증된 사실, 수치, 경계 또는 규칙을 자세히 설명하세요...",
      "confidenceSection": "신뢰도 수준",
      "confidenceLabel": "검증 수준",
      "confidenceOptions": {
        "high100": "검증된 사실(100% - 확정된 기준 규칙)",
        "med80": "높은 신뢰도(80% - 충분히 관찰됨)",
        "low50": "가설(50% - 탐색 중)"
      },
      "cancel": "취소",
      "saving": "정보 저장 중...",
      "saveChanges": "변경 사항 저장",
      "saveFact": "메모리 정보 저장",
      "errors": {
        "titleRequired": "제목이 필요합니다",
        "contentRequired": "정보 내용 설명이 필요합니다",
        "saveFailed": "메모리 항목을 저장하지 못했습니다"
      },
      "defaultBusinessName": "내 비즈니스"
    },
    "toasts": {
      "copied": "메모리 정보를 클립보드에 복사했습니다",
      "updated": "메모리 항목을 업데이트했습니다",
      "saved": "새 메모리 항목을 저장했습니다",
      "deleted": "삭제됨: \"{title}\"",
      "deleteError": "메모리 항목을 삭제하지 못했습니다"
    },
    "dialogs": {
      "deleteTitle": "메모리 정보를 삭제하시겠습니까?",
      "deleteMessage": "메모리 항목 \"{title}\"을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
      "deleteConfirm": "삭제",
      "deleteCancel": "취소"
    }
  },
  "skillsPage": {
    "eyebrow": "설정 · 스킬",
    "backToSettings": "설정으로 돌아가기",
    "title": "에이전트 스킬",
    "heroCopy": "NPATI Agent가 요청에 따라 자동으로 선택하는 기본 비즈니스 기능을 살펴보세요.",
    "badgeBuiltin": "기본 카탈로그",
    "stats": {
      "availableSkills": "사용 가능한 스킬",
      "availableSkillsDesc": "등록된 에이전트 워크플로",
      "capabilities": "기능",
      "capabilitiesDesc": "에이전트가 사용할 수 있는 작업",
      "autoValue": "자동",
      "skillSelection": "스킬 선택",
      "skillSelectionDesc": "요청과 맥락에 맞춰 선택됨"
    },
    "searchPlaceholder": "스킬 및 기능 검색...",
    "searchAria": "스킬 필터링",
    "clearSearch": "검색 지우기",
    "statusShowing": {
      "showing": "표시 중",
      "of": "/",
      "skills": "스킬"
    },
    "errorLoading": "스킬을 불러오지 못했습니다",
    "empty": {
      "title": "일치하는 스킬 없음",
      "description": "다른 이름, 설명 또는 기능을 검색해 보세요.",
      "clearSearch": "검색 지우기"
    },
    "card": {
      "available": "사용 가능",
      "builtinType": "기본 스킬"
    },
    "skills": {
      "competitorAnalysis": {
        "name": "경쟁사 분석",
        "desc": "관련 경쟁사를 찾고 공개 근거를 현재 비즈니스 맥락과 비교합니다."
      },
      "webResearch": {
        "name": "웹 조사",
        "desc": "보호된 NPATI Web Research 경계 내에서 공개 웹 출처를 검색하고 읽습니다."
      },
      "businessStartup": {
        "name": "사업 시작",
        "desc": "사업 아이디어, 고객층, 제안 및 첫 검증 계획을 구체화합니다."
      },
      "businessGrowth": {
        "name": "사업 성장",
        "desc": "실질적인 고객 확보, 유지, 포지셔닝 및 성장 기회를 찾습니다."
      },
      "sellProduct": {
        "name": "제품 판매",
        "desc": "제품이나 서비스를 명확한 제안 및 판매 계획으로 정리합니다."
      }
    }
  }
} satisfies Pick<TranslationSchema, "goalsPage" | "contentPage" | "connectionsPage" | "memoryPage" | "skillsPage">;

import type { TranslationSchema } from "../../types";

export const activity = {
  "capabilityInspector": {
    "eyebrow": "거버넌스 및 보안",
    "title": "기능 검사기",
    "backAria": "설정으로 돌아가기",
    "modelProfiles": {
      "title": "모델 프로필: 보수적인 대체 설정.",
      "emptyHint": "이 맥락에서는 code.model_profile.<id> 플래그가 활성화되어 있지 않으므로 모델이 레지스트리 프로필 {{count}}개 중 하나와 일치하더라도 모든 실행에 보수적인 프로필(한 번에 도구 호출 하나, 도구 호출 자동 감지)을 사용합니다. 배포를 시작하려면 이 환경에서 허용하는 프로필의 플래그를 활성화하세요."
    },
    "heroCopy": "NPATI Agent의 표준 기능 306개를 살펴보고 감사하세요. 실제 실행 환경에서 Effective Capability Resolver 경계, 도구 공개 범위 및 위험 정책을 검증합니다.",
    "stats": {
      "totalLabel": "전체 기능",
      "totalDesc": "검증된 표준 ID 1..306",
      "agentCallableLabel": "에이전트 호출 가능",
      "agentCallableDesc": "Resolver를 통해 모델에 공개됨",
      "runtimeOnlyLabel": "내부 실행 환경",
      "runtimeOnlyDesc": "격리된 엔진 작업",
      "requiresApprovalLabel": "승인 필요",
      "requiresApprovalDesc": "사람이 개입하는 보안 게이트"
    },
    "slices": {
      "all": "전체",
      "agentCallable": "에이전트 호출 가능",
      "runtimeOnly": "실행 환경 전용",
      "userVisible": "사용자에게 표시",
      "automatic": "자동",
      "allowed": "허용됨",
      "requiresApproval": "승인 필요"
    },
    "controls": {
      "searchPlaceholder": "이름, ID 또는 영역으로 기능 필터링...",
      "searchAriaLabel": "기능 필터링",
      "clearSearch": "검색 지우기",
      "showing": "기능 {{total}}개 중 {{start}}–{{end}}개 표시",
      "matching": "\"{{term}}\"과 일치",
      "copied": "✓ {{id}} 복사됨",
      "perPage": "페이지당:",
      "allCount": "전체({{total}}개)"
    },
    "table": {
      "colId": "ID",
      "sortId": "ID순 정렬",
      "colName": "이름",
      "sortName": "이름순 정렬",
      "colCanonicalId": "표준 ID",
      "sortCanonicalId": "표준 ID순 정렬",
      "colDomain": "영역",
      "sortDomain": "영역순 정렬",
      "colType": "유형",
      "sortType": "유형순 정렬",
      "colCallable": "호출 가능 여부",
      "colRisk": "위험",
      "sortRisk": "위험순 정렬",
      "colStatus": "상태",
      "sortStatus": "상태순 정렬",
      "copyTooltip": "클릭하여 표준 ID 복사",
      "empty": "선택한 필터와 일치하는 기능이 없습니다.",
      "prev": "← 이전",
      "next": "다음 →"
    },
    "callable": {
      "callable": "호출 가능 여부",
      "internal": "내부"
    },
    "risks": {
      "low": "낮음",
      "medium": "중간",
      "high": "높음",
      "critical": "심각"
    },
    "statuses": {
      "verified": "검증됨",
      "partial": "부분 지원",
      "notImplemented": "구현되지 않음",
      "blocked": "차단됨",
      "allowed": "허용됨",
      "denied": "거부됨",
      "unavailable": "사용 불가",
      "requiresApproval": "승인 필요"
    },
    "types": {
      "runtime": "실행 환경",
      "config": "구성",
      "orchestr": "조율",
      "tool": "도구",
      "article": "기사",
      "secOps": "보안 운영"
    },
    "connectedServices": "연결된 서비스",
    "errorLoad": "기능을 불러오지 못했습니다",
    "integrations": {
      "kicker": "검증된 제품 통합",
      "title": "구현된 메시징 채널",
      "manage": "통합 관리",
      "sharedRuntime": "공유 NPATI Agent 실행 환경",
      "loading": "통합 상태 불러오는 중...",
      "notice": "Agent API가 연결되면 통합 상태를 확인할 수 있습니다."
    }
  },
  "activity": {
    "eyebrow": "관측 및 감사",
    "title": "활동 및 실행 추적",
    "backAria": "설정으로 돌아가기",
    "heroCopy": "회사 에이전트 실행 전반의 실시간 실행 추적, 위임 단계, 도구 호출, 지연 시간 및 보안 결정을 자세히 확인합니다.",
    "stats": {
      "totalRuns": "전체 실행",
      "totalRunsDesc": "기록된 에이전트 실행",
      "completed": "완료",
      "completedDesc": "오류 없이 성공",
      "inProgress": "진행 중 / 대기열",
      "inProgressDesc": "활성 에이전트 작업",
      "securityDecisions": "보안 결정",
      "securityDecisionsDesc": "감사된 도구 검사"
    },
    "controls": {
      "companyLabel": "회사:",
      "all": "전체",
      "completed": "완료",
      "running": "실행 중",
      "failed": "실패",
      "searchPlaceholder": "작업이나 ID로 실행 검색...",
      "searchAriaLabel": "실행 검색",
      "clearSearch": "검색 지우기",
      "refresh": "새로고침",
      "refreshing": "새로고침 중...",
      "refreshTitle": "실행 새로고침"
    },
    "dispatch": {
      "title": "회사 에이전트 작업 전달",
      "subtitle": "자율 다중 에이전트 작업을 실행하고 실시간 추적을 확인합니다",
      "modeLabel": "실행 모드:",
      "modes": {
        "auto": "자동 조율(적응형)",
        "pipeline": "파이프라인(다중 에이전트)",
        "single": "단일 에이전트(빠름)",
        "fusion": "융합(다중 모델)"
      },
      "placeholderWithCompany": "{{name}} 에이전트의 작업을 입력하세요(예: '경쟁사 제안 및 가격 분석')...",
      "placeholderDefault": "회사 에이전트의 작업 프롬프트 입력...",
      "dispatchTask": "작업 전달",
      "dispatching": "전달 중...",
      "presetsLabel": "사전 설정:",
      "presets": {
        "marketAuditLabel": "시장 및 경쟁사 감사",
        "marketAuditPrompt": "포괄적인 경쟁사 조사 및 시장 포지셔닝 분석 수행",
        "securityAuditLabel": "보안 및 기능 검증",
        "securityAuditPrompt": "회사 도구 권한, API 접근 규칙 및 보안 게이트 감사",
        "growthRoadmapLabel": "전략적 성장 로드맵",
        "growthRoadmapPrompt": "대상 고객 프로필과 실행 가능한 90일 성장 로드맵 종합"
      },
      "dispatchedNotice": "실행 전달됨: {{id}}({{status}})",
      "dispatchFailed": "에이전트 실행을 전달하지 못했습니다"
    },
    "empty": {
      "noCompaniesTitle": "회사를 찾을 수 없습니다",
      "noCompaniesCopy": "활동 및 실행 추적은 AI 회사 맥락에서 전달된 다중 에이전트 실행을 추적합니다.",
      "createCompanyBtn": "AI 회사 만들기",
      "noRunsTitle": "기록된 실행이 아직 없습니다",
      "presetsTitle": "작업 사전 설정 및 시작 시나리오",
      "noRunsCopy": "이 회사에는 전달된 에이전트 실행이 없습니다. 위 작업 전달 기능이나 사전 설정을 사용하여 실시간 실행 추적, 위임 단계 및 도구 보안 감사를 생성하세요.",
      "presetsCopy": "아래 사전 설정을 선택하거나 위에 사용자 지정 작업을 입력하여 실시간 실행 추적, 위임 단계 및 도구 보안 감사를 생성하세요.",
      "dispatchPresetBtn": "전달: {{label}} →",
      "viewTraceBtn": "실행 기록 및 추적 보기({{count}}) →"
    },
    "sidebar": {
      "recentExecutions": "최근 실행({{count}})",
      "backToPresets": "← 사전 설정 3개",
      "noFilteredRuns": "현재 필터 조건과 일치하는 실행이 없습니다.",
      "clearFiltersBtn": "필터 지우기"
    },
    "trace": {
      "backToPresetsAria": "사전 설정으로 돌아가기",
      "modePrefix": "모드: {{mode}}",
      "comboPrefix": "조합: {{name}}",
      "runIdLabel": "실행 ID:",
      "copy": "복사",
      "copied": "복사됨",
      "copyRunIdTitle": "실행 ID 복사",
      "startedLabel": "시작:",
      "completedLabel": "완료:",
      "durationLabel": "소요 시간:",
      "finalOutput": "최종 출력 결과",
      "copyResultTitle": "결과 복사",
      "executionFault": "실행 오류",
      "completionReportTitle": "백그라운드 완료 보고서",
      "attemptSummary": "시도 {{attempt}} · {{tokens}} 토큰 · ${{cost}} · {{duration}}초",
      "timelineTitle": "백그라운드 실행 타임라인({{count}})",
      "timelineDesc": "영구 작업자의 작업 확보, 재시도 및 최종 완료 이벤트",
      "attemptLabel": "시도 {{attempt}}",
      "synchronousNotice": "이 실행은 동기식으로 수행되어 백그라운드 작업자 이벤트가 발생하지 않았습니다.",
      "delegationTitle": "에이전트 위임 파이프라인({{count}})",
      "delegationDesc": "다중 에이전트 역할 조율 및 인계",
      "agentPrefix": "에이전트: {{id}}",
      "modelPrefix": "모델:",
      "lanePrefix": "레인: {{lane}}",
      "noStepsNotice": "이 단일 턴 작업에는 기록된 위임 단계가 없습니다.",
      "toolsTitle": "도구 실행 및 보안 정책 게이트({{count}})",
      "toolsDesc": "표준 기능 리졸버 검사 및 안전 감사",
      "policyReason": "정책 사유:",
      "noToolsNotice": "이 실행 중 외부 도구 호출이 발생하지 않았습니다.",
      "selectRunTitle": "검사할 실행 선택",
      "selectRunCopy": "왼쪽 패널에서 실행을 선택하여 타임라인, 위임 단계 및 보안 감사를 검토하세요."
    },
    "errors": {
      "loadRunsFailed": "활동을 불러오지 못했습니다",
      "loadRunDetailsFailed": "실행 세부 정보를 불러오지 못했습니다"
    }
  },
  "automations": {
    "eyebrow": "설정 · 자동화",
    "title": "자동화 및 예약 작업",
    "backAria": "설정으로 돌아가기",
    "heroCopy": "회사의 주기적인 백그라운드 트리거, 반복 cron 작업 및 자율 에이전트 작업을 구성하세요.",
    "selectCompanyAria": "회사 선택",
    "newAutomationBtn": "+ 새 자동화",
    "stats": {
      "total": "전체 자동화",
      "totalDesc": "예약된 AI 백그라운드 작업",
      "active": "활성 트리거",
      "activeDesc": "실행 중인 cron 일정",
      "paused": "일시 중지된 일정",
      "pausedDesc": "대기 / 비활성 트리거",
      "assignedAgents": "할당된 에이전트",
      "assignedAgentsDesc": "구성된 에이전트 실행기"
    },
    "controls": {
      "searchPlaceholder": "이름, 설명, 프롬프트, cron으로 자동화 필터링...",
      "searchAriaLabel": "자동화 필터링",
      "clearSearch": "검색 지우기",
      "tabAll": "전체",
      "tabActive": "활성",
      "tabPaused": "일시 중지"
    },
    "showingStatus": "자동화 {{total}}개 중 {{count}}개 표시",
    "matchingQuery": "\"{{query}}\"과 일치",
    "empty": {
      "noAutomationsTitle": "구성된 자동화 없음",
      "noAutomationsDesc": "이 회사의 자율 cron 백그라운드 작업, 주기적인 시장 감사 또는 일일 에이전트 워크플로를 예약하세요.",
      "createFirstBtn": "+ 첫 자동화 만들기",
      "noMatchingTitle": "일치하는 자동화 없음",
      "noMatchingDesc": "검색어나 상태 필터를 조정하여 원하는 항목을 찾아보세요.",
      "clearFiltersBtn": "필터 지우기"
    },
    "table": {
      "colStatus": "상태",
      "colTask": "작업 및 지침",
      "colSchedule": "일정(Cron)",
      "colAssignedAgent": "할당된 에이전트",
      "colActions": "작업",
      "statusActive": "활성",
      "statusPaused": "일시 중지",
      "clickToPause": "클릭하여 일시 중지",
      "clickToActivate": "클릭하여 활성화",
      "promptPrefix": "프롬프트:",
      "nextRunPrefix": "다음:",
      "mainAgent": "주 에이전트",
      "runNow": "▶ 지금 실행",
      "running": "실행 중...",
      "runNowTitle": "이 자동화를 즉시 실행",
      stop: "중지",
      stopTitle: "진행 중인 실행 중지",
      "history": "기록",
      "historyTitle": "실행 기록 보기",
      "edit": "수정",
      "editTitle": "자동화 설정 수정",
      "delete": "삭제",
      "deleteTitle": "자동화 삭제"
    },
    "presets": {
      "daily9": "매일 09:00",
      "daily18": "매일 18:00",
      "mondays9": "매주 월요일 09:00",
      "fridays17": "매주 금요일 17:00",
      "hourly": "매시간",
      "daily0": "매일 00:00"
    },
    "editor": {
      "kicker": "자동화",
      "editTitle": "자동화 수정",
      "newTitle": "새 자동화",
      "taskParamsHeading": "작업 매개변수",
      "taskNameLabel": "작업 이름",
      "taskNamePlaceholder": "예: 일일 경쟁사 분석",
      "descLabel": "설명",
      "descPlaceholder": "이 자동화가 수행하는 내용",
      "assignedAgentLabel": "할당된 에이전트",
      "mainAgentDefault": "주 에이전트(기본)",
      "schedulePresetsLabel": "일정 사전 설정",
      "cronExpressionLabel": "Cron 표현식(5개 필드: 분 시 일 월 요일)",
      "cronPlaceholder": "0 9 * * *",
      "agentPromptLabel": "에이전트 프롬프트",
      "agentPromptPlaceholder": "에이전트가 실행할 정확한 목표와 단계를 설명하세요...",
      "saveBtn": "자동화 저장",
      "savingBtn": "저장 중...",
      "deleteBtn": "삭제",
      "cancelBtn": "취소"
    },
    "history": {
      "kicker": "실행 기록",
      "loading": "실행 기록 불러오는 중...",
      "noRuns": "기록된 실행이 아직 없습니다.",
      "duration": "소요 시간:",
      "finalResult": "✓ 최종 결과:",
      "error": "오류:"
    },
    "dialogs": {
      "deleteTitle": "자동화를 삭제하시겠습니까?",
      "deleteMessage": "이 자동화를 삭제하시겠습니까?",
      "deleteConfirm": "삭제",
      "deleteCancel": "취소"
    },
    "notifications": {
      "runInitiated": "\"{{name}}\" 실행을 시작했습니다.",
      stopped: "“{{name}}” 실행을 중지했습니다.",
      "resultReceived": "결과를 받았습니다!",
      "runError": "실행 오류: {{error}}"
    }
  }
} satisfies Pick<TranslationSchema, "capabilityInspector" | "activity" | "automations">;

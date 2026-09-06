// Auto-generated Tool Test Matrix for agent-callable capabilities
// Generated according to Section 11 of NPATI_AGENT_CAPABILITY_INTEGRATION_MASTER_PLAN.md

export interface ToolTestMatrixEntry {
  tool_id: string;
  name: string;
  domain: string;
  positive_prompts: string[];
  negative_prompts: string[];
  expected_skill: string;
  expected_called: boolean;
  forbidden_tools: string[];
  permission_cases: Array<"allowed" | "denied at company" | "denied at agent">;
  failure_cases: Array<"timeout" | "provider_429" | "provider_5xx" | "malformed_response">;
  concurrency_cases: Array<"duplicate_submission">;
  audit_required: boolean;
}

export const TOOL_TEST_MATRIX: ToolTestMatrixEntry[] = [
  {
    "tool_id": "research.web_search",
    "name": "Web search",
    "domain": "research",
    "positive_prompts": [
      "Виконай web search для отримання актуальних даних",
      "Запусти Web search у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке web search у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "research",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.web_fetch",
    "name": "Web fetch",
    "domain": "browser",
    "positive_prompts": [
      "Виконай web fetch для отримання актуальних даних",
      "Запусти Web fetch у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке web fetch у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.text-to-speech",
    "name": "Text-to-Speech",
    "domain": "system",
    "positive_prompts": [
      "Виконай text-to-speech для отримання актуальних даних",
      "Запусти Text-to-Speech у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке text-to-speech у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.speech-to-text",
    "name": "Speech-to-Text",
    "domain": "system",
    "positive_prompts": [
      "Виконай speech-to-text для отримання актуальних даних",
      "Запусти Speech-to-Text у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке speech-to-text у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.image_generation",
    "name": "Image generation",
    "domain": "system",
    "positive_prompts": [
      "Виконай image generation для отримання актуальних даних",
      "Запусти Image generation у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке image generation у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.ocr",
    "name": "OCR",
    "domain": "system",
    "positive_prompts": [
      "Виконай ocr для отримання актуальних даних",
      "Запусти OCR у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке ocr у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.imap_email_trigger",
    "name": "IMAP email trigger",
    "domain": "communications",
    "positive_prompts": [
      "Виконай imap email trigger для отримання актуальних даних",
      "Запусти IMAP email trigger у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке imap email trigger у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.one-shot_reminders",
    "name": "One-shot reminders",
    "domain": "system",
    "positive_prompts": [
      "Виконай one-shot reminders для отримання актуальних даних",
      "Запусти One-shot reminders у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке one-shot reminders у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.image_understanding",
    "name": "Image understanding",
    "domain": "communications",
    "positive_prompts": [
      "Виконай image understanding для отримання актуальних даних",
      "Запусти Image understanding у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке image understanding у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "files.document_inputoutput",
    "name": "Document input/output",
    "domain": "files",
    "positive_prompts": [
      "Виконай document input/output для отримання актуальних даних",
      "Запусти Document input/output у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке document input/output у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "file_management",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.audio_understanding",
    "name": "Audio understanding",
    "domain": "communications",
    "positive_prompts": [
      "Виконай audio understanding для отримання актуальних даних",
      "Запусти Audio understanding у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке audio understanding у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.image_generationediting",
    "name": "Image generation/editing",
    "domain": "communications",
    "positive_prompts": [
      "Виконай image generation/editing для отримання актуальних даних",
      "Запусти Image generation/editing у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке image generation/editing у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.audio_translation",
    "name": "Audio translation",
    "domain": "communications",
    "positive_prompts": [
      "Виконай audio translation для отримання актуальних даних",
      "Запусти Audio translation у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке audio translation у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.video_understanding",
    "name": "Video understanding",
    "domain": "communications",
    "positive_prompts": [
      "Виконай video understanding для отримання актуальних даних",
      "Запусти Video understanding у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке video understanding у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.browser_tab_control",
    "name": "Browser tab control",
    "domain": "browser",
    "positive_prompts": [
      "Виконай browser tab control для отримання актуальних даних",
      "Запусти Browser tab control у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке browser tab control у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.browser_clicktype",
    "name": "Browser click/type",
    "domain": "browser",
    "positive_prompts": [
      "Виконай browser click/type для отримання актуальних даних",
      "Запусти Browser click/type у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке browser click/type у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.browser_screenshots",
    "name": "Browser screenshots",
    "domain": "browser",
    "positive_prompts": [
      "Виконай browser screenshots для отримання актуальних даних",
      "Запусти Browser screenshots у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке browser screenshots у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.browser_pdf_capture",
    "name": "Browser PDF capture",
    "domain": "browser",
    "positive_prompts": [
      "Виконай browser pdf capture для отримання актуальних даних",
      "Запусти Browser PDF capture у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке browser pdf capture у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "browser.browser_downloads",
    "name": "Browser downloads",
    "domain": "browser",
    "positive_prompts": [
      "Виконай browser downloads для отримання актуальних даних",
      "Запусти Browser downloads у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке browser downloads у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "browser_automation",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.coding_cli_gateway",
    "name": "Coding CLI gateway",
    "domain": "system",
    "positive_prompts": [
      "Виконай coding cli gateway для отримання актуальних даних",
      "Запусти Coding CLI gateway у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке coding cli gateway у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.claude_code_via_acp",
    "name": "Claude Code via ACP",
    "domain": "system",
    "positive_prompts": [
      "Виконай claude code via acp для отримання актуальних даних",
      "Запусти Claude Code via ACP у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке claude code via acp у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.cursor_via_acp",
    "name": "Cursor via ACP",
    "domain": "system",
    "positive_prompts": [
      "Виконай cursor via acp для отримання актуальних даних",
      "Запусти Cursor via ACP у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке cursor via acp у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.github_copilot_via_acp",
    "name": "GitHub Copilot via ACP",
    "domain": "system",
    "positive_prompts": [
      "Виконай github copilot via acp для отримання актуальних даних",
      "Запусти GitHub Copilot via ACP у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке github copilot via acp у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.gemini_cli_via_acp",
    "name": "Gemini CLI via ACP",
    "domain": "system",
    "positive_prompts": [
      "Виконай gemini cli via acp для отримання актуальних даних",
      "Запусти Gemini CLI via ACP у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке gemini cli via acp у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.opencode_via_acp",
    "name": "OpenCode via ACP",
    "domain": "system",
    "positive_prompts": [
      "Виконай opencode via acp для отримання актуальних даних",
      "Запусти OpenCode via ACP у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке opencode via acp у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.other_acp_harnesses",
    "name": "Other ACP harnesses",
    "domain": "system",
    "positive_prompts": [
      "Виконай other acp harnesses для отримання актуальних даних",
      "Запусти Other ACP harnesses у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке other acp harnesses у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.telegram",
    "name": "Telegram",
    "domain": "communications",
    "positive_prompts": [
      "Виконай telegram для отримання актуальних даних",
      "Запусти Telegram у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке telegram у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "research.x_search",
    "name": "X search",
    "domain": "research",
    "positive_prompts": [
      "Виконай x search для отримання актуальних даних",
      "Запусти X search у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке x search у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "research",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.video_generation",
    "name": "Video generation",
    "domain": "system",
    "positive_prompts": [
      "Виконай video generation для отримання актуальних даних",
      "Запусти Video generation у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке video generation у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.music_generation",
    "name": "Music generation",
    "domain": "communications",
    "positive_prompts": [
      "Виконай music generation для отримання актуальних даних",
      "Запусти Music generation у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке music generation у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.talk_realtime_speech",
    "name": "Talk / realtime speech",
    "domain": "communications",
    "positive_prompts": [
      "Виконай talk / realtime speech для отримання актуальних даних",
      "Запусти Talk / realtime speech у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке talk / realtime speech у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.voice_call",
    "name": "Voice Call",
    "domain": "communications",
    "positive_prompts": [
      "Виконай voice call для отримання актуальних даних",
      "Запусти Voice Call у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке voice call у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.macos_companion",
    "name": "macOS companion",
    "domain": "system",
    "positive_prompts": [
      "Виконай macos companion для отримання актуальних даних",
      "Запусти macOS companion у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке macos companion у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.ios_node_pairing",
    "name": "iOS node pairing",
    "domain": "system",
    "positive_prompts": [
      "Виконай ios node pairing для отримання актуальних даних",
      "Запусти iOS node pairing у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке ios node pairing у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.android_node_pairing",
    "name": "Android node pairing",
    "domain": "system",
    "positive_prompts": [
      "Виконай android node pairing для отримання актуальних даних",
      "Запусти Android node pairing у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке android node pairing у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "communications.mobile_voice",
    "name": "Mobile voice",
    "domain": "communications",
    "positive_prompts": [
      "Виконай mobile voice для отримання актуальних даних",
      "Запусти Mobile voice у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке mobile voice у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "communications",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.camera_access",
    "name": "Camera access",
    "domain": "system",
    "positive_prompts": [
      "Виконай camera access для отримання актуальних даних",
      "Запусти Camera access у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке camera access у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.screen_recording",
    "name": "Screen recording",
    "domain": "system",
    "positive_prompts": [
      "Виконай screen recording для отримання актуальних даних",
      "Запусти Screen recording у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке screen recording у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.location_access",
    "name": "Location access",
    "domain": "system",
    "positive_prompts": [
      "Виконай location access для отримання актуальних даних",
      "Запусти Location access у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке location access у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "system.device_commands",
    "name": "Device commands",
    "domain": "system",
    "positive_prompts": [
      "Виконай device commands для отримання актуальних даних",
      "Запусти Device commands у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке device commands у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "system_ops",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "storage.company_memory",
    "name": "Company memory",
    "domain": "storage",
    "positive_prompts": [
      "Виконай company memory для отримання актуальних даних",
      "Запусти Company memory у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке company memory у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "general",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  },
  {
    "tool_id": "storage.agent_knowledge_retrieval",
    "name": "Agent knowledge retrieval",
    "domain": "storage",
    "positive_prompts": [
      "Виконай agent knowledge retrieval для отримання актуальних даних",
      "Запусти Agent knowledge retrieval у робочому середовищі компанії"
    ],
    "negative_prompts": [
      "Поясни загальне поняття без виклику інструментів",
      "Що таке agent knowledge retrieval у загальній теорії комп'ютерних наук?"
    ],
    "expected_skill": "general",
    "expected_called": true,
    "forbidden_tools": [
      "system.database_drop",
      "security.raw_credential_dump"
    ],
    "permission_cases": [
      "allowed",
      "denied at company",
      "denied at agent"
    ],
    "failure_cases": [
      "timeout",
      "provider_429",
      "provider_5xx",
      "malformed_response"
    ],
    "concurrency_cases": [
      "duplicate_submission"
    ],
    "audit_required": true
  }
];

export function getToolTestMatrix(toolId: string): ToolTestMatrixEntry | undefined {
  const norm = toolId.trim().toLowerCase();
  return TOOL_TEST_MATRIX.find(
    (entry) => entry.tool_id.toLowerCase() === norm || entry.tool_id.toLowerCase().endsWith("." + norm)
  );
}

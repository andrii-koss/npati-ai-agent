# Known issues (v0.1 beta)

NPATI Agent is in beta. The core was checked end to end on 2026-11-18 (chat, projects, games, web mobile apps, backends
and Data Studio, companies and agents, memory, 16 languages, a 200-message chat, security and recovery). The problems
below are known and not fixed yet. Found something else? Open an issue on GitHub.

## Not available yet

- **Android APK builds and running on a phone or emulator.** Mobile apps (Expo, Flutter) run in the browser preview;
  native builds need an Android SDK that the default installation does not include.
- **Discord, Slack and WhatsApp.** They appear in Integrations but have not been verified end to end. Telegram works.
- **Teams with several user accounts.** Sharing a company between different accounts has not been verified.

## Known problems

- **A Preview link can show "Preview Connection Failed" after a restart.** If the server or Docker restarted, a
  direct Preview link may answer 502. Open the project in the chat or on the Projects page: the Preview starts again.
- **"Change this" in a company chat.** When the chat has only a company selected (no project), a request such as
  "make this red" may not reach a project, and the agent may say it cannot edit files. Name the project or open its
  chat.
- **"The second one" can be misread.** In a chat with several projects, the agent can occasionally pick the right
  project but think you meant another one. Naming the project avoids this.
- **APK or emulator requests end with a generic error.** Instead of saying that the Android SDK is missing, the run
  may stop with "the same error repeated".
- **An internal e-mail reference can appear in a reply.** When the agent talks about a sender, the reply may show a
  placeholder like `EMAIL_REF_…` instead of the address.
- **Dutch "bedrijf" can create a business profile instead of a company.** Write "AI-bedrijf" or use Settings → Company.
- **Small coding misses.** After a change to a Python (Pygame) game the agent may skip running the tests; a database
  rule such as "e-mail must be unique" may not be created; a layout move ("bottom left") may be only partly done.
  Check the result in the Preview and ask again if needed.

import type { DevelopmentTarget } from "@npati/shared";

/** Creation starts from blank content; existing-project edits keep their separate read/edit path. */
export function createProjectImplementationPrompt(message: string, target: DevelopmentTarget): string {
  return [
    "Begin with a brief acknowledgement in the user's language alongside your first tool calls, then implement the complete request.",
    "User request: " + message,
    "Your assigned project is " + target.name + " (" + target.kind + "), using " + target.framework + ". Implement ONLY this project's specification; other requested projects have separate workspaces.",
    target.framework === "HTML/CSS"
      ? "This is a NEW, EMPTY HTML/CSS/JavaScript workspace. No design or starter files exist. Start by writing index.html and the required CSS/JavaScript files with code.fs.write. Do not list or search for a template, read nonexistent files, add a framework, or install packages unless the user's request needs them."
      : "Only minimal framework configuration and empty entry points have been prepared. Implement the requested pages and interactions directly; there is no demo design to analyze or preserve. Read only the configuration or existing files needed for your edits; use code.fs.edit for an existing file and code.fs.write for a new file.",
    "Do not add tests, CI, architecture or features the user did not request. Complete every requested deliverable; a title, H1 or placeholder section is not a finished website.",
    "No database is provisioned merely by creating a site. Decide from the user's requirements whether server-side persistent data is needed. Plain layouts, demo catalogs and browser-local carts do not require a database. If the user asks for a database, or requested working features require durable shared data, explain why and call code.data.backend.create with a concise reason. Use its returned backend identity and public API configuration; inspect the schema before applying changes. Never use shell/database credentials or invent successful provisioning. After success, tell the user which database was created and what it stores. If no database is necessary, continue without data tools.",
    "The system performs final build/verification and starts Preview after your implementation. Do not call code.verify.run yourself. Stop after the requested implementation is saved. Report any remaining deliverables truthfully if blocked.",
  ].join("\n");
}

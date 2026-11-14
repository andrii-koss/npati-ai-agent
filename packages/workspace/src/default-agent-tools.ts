/**
 * Tools a new company agent gets when its creator names none: it can list, search and read the company's project
 * files, but not change them. Owner decision in V6 step 14: agents asked to review a project (A041) could not read a
 * single file, because chat-created agents got no tools at all. Writes still need an explicit grant.
 */
export const DEFAULT_AGENT_READ_TOOLS: readonly string[] = ["project.files.list", "project.files.search", "project.files.read"];

export interface ShellSegment {
    argv: string[];
    /** The operator that preceded this segment (`&&`, `||`, `;`, `|`, `&`). */
    operator?: string;
    raw: string;
}
export interface ParsedShellCommand {
    segments: ShellSegment[];
    usesSubshell: boolean;
    usesBackticks: boolean;
    usesHeredoc: boolean;
    usesVariables: boolean;
    redirectsToOutside: boolean;
    parseError?: string;
}
export function stripQuotes(value: string): string {
    const trimmed = value.trim();
    if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        return trimmed.slice(1, -1);
    return trimmed;
}
/** A real tokeniser for a shell command line: operators, quoting and escaping are handled. */
export function parseShellCommand(command: string): ParsedShellCommand {
    const segments: ShellSegment[] = [];
    const parsed: ParsedShellCommand = {
        segments, usesSubshell: false, usesBackticks: false, usesHeredoc: false, usesVariables: false,
        redirectsToOutside: false,
    };
    if (typeof command !== "string" || !command.trim()) {
        return { ...parsed, parseError: "empty_command" };
    }
    parsed.usesSubshell = /\$\(/.test(command);
    parsed.usesBackticks = /`[^`]*`/.test(command);
    parsed.usesHeredoc = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(command);
    parsed.usesVariables = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(command);
    parsed.redirectsToOutside = /(?:^|[\s;&|])>>?\s*(?:\/(?!workspace|tmp|dev\/null|proc\/self))/.test(command);
    let current = "";
    let quote: '"' | "'" | null = null;
    let pendingOperator: string | undefined;
    const push = () => {
        const raw = current.trim();
        if (raw)
            segments.push({ argv: tokenise(raw), operator: pendingOperator, raw });
        current = "";
        pendingOperator = undefined;
    };
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index]!;
        if (quote) {
            current += char;
            if (char === quote && command[index - 1] !== "\\")
                quote = null;
            continue;
        }
        if (char === "'" || char === "\"") {
            quote = char;
            current += char;
            continue;
        }
        const two = command.slice(index, index + 2);
        if (two === "&&" || two === "||" || two === ">>" || two === "2>") {
            if (two === ">>" || two === "2>") {
                current += two;
                index += 1;
                continue;
            }
            push();
            pendingOperator = two;
            index += 1;
            continue;
        }
        if (char === "|" || char === ";" || char === "&") {
            if (char === "|" && command[index + 1] === "|") {
                push();
                pendingOperator = "||";
                index += 1;
                continue;
            }
            push();
            pendingOperator = char;
            continue;
        }
        current += char;
    }
    if (quote)
        parsed.parseError = "unterminated_quote";
    push();
    if (!segments.length)
        parsed.parseError = parsed.parseError ?? "no_segments";
    return parsed;
}
export function tokenise(raw: string): string[] {
    const argv: string[] = [];
    let token = "";
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index]!;
        if (quote) {
            if (char === quote && raw[index - 1] !== "\\") {
                quote = null;
                continue;
            }
            token += char;
            continue;
        }
        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }
        if (char === "\\" && raw[index + 1]) {
            token += raw[index + 1];
            index += 1;
            continue;
        }
        if (/\s/.test(char)) {
            if (token) {
                argv.push(token);
                token = "";
            }
            continue;
        }
        token += char;
    }
    if (token)
        argv.push(token);
    return argv;
}

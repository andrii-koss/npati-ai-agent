export function parseExactHttpOrigin(raw?: string | null): string | null {
    if (!raw || typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes("*"))
        return null;
    try {
        const url = new URL(trimmed);
        if (!["http:", "https:"].includes(url.protocol))
            return null;
        if (url.origin !== trimmed)
            return null;
        return url.origin;
    }
    catch {
        return null;
    }
}

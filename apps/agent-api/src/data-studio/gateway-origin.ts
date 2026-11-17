export function sameOriginAsHost(origin: string, host: string | undefined): boolean {
    if (!host)
        return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}

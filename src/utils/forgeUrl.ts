/** Returns a user-facing error for an invalid Forge base URL, or null when it is usable. */
export function getForgeUrlError(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) {
        return "Forge URL is required (for example http://127.0.0.1:7860).";
    }
    try {
        const parsed = new URL(trimmed);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return "Forge URL must start with http:// or https://.";
        }
    } catch {
        return "Enter a valid Forge URL (for example http://127.0.0.1:7860).";
    }
    return null;
}

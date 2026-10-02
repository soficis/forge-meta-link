export interface BooruTagFilterResult {
    include: string[];
    exclude: string[];
}

export function parseBooruTagFilter(input: string): BooruTagFilterResult {
    const include: string[] = [];
    const exclude: string[] = [];
    const seenInclude = new Set<string>();
    const seenExclude = new Set<string>();

    const tokenRegex = /([+-]?)(?:"([^"]+)"|([^,\s]+))/g;
    let match: RegExpExecArray | null = tokenRegex.exec(input);
    while (match) {
        const prefix = match[1] || "";
        const rawContent = (match[2] ?? match[3] ?? "").trim().toLowerCase();
        const token = rawContent.replace(/^,+|,+$/g, "").trim();
        if (token) {
            if (prefix === "-") {
                if (!seenExclude.has(token)) {
                    seenExclude.add(token);
                    exclude.push(token);
                }
            } else {
                if (!seenInclude.has(token)) {
                    seenInclude.add(token);
                    include.push(token);
                }
            }
        }
        match = tokenRegex.exec(input);
    }

    return {
        include: include.filter((token) => !seenExclude.has(token)),
        exclude,
    };
}

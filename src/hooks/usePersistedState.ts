import { useState, useEffect, type Dispatch, type SetStateAction } from "react";

interface PersistedStateOptions<T> {
    serialize?: (value: T) => string;
    deserialize?: (raw: string) => T | undefined;
}

/**
 * A typed wrapper around useState that persists to localStorage.
 *
 * On mount the value is read from localStorage and deserialized.
 * Every state change is serialized back to localStorage.
 *
 * For primitive strings you can omit options entirely — the raw
 * localStorage value (or `defaultValue`) is used as-is.
 */
export function usePersistedState<T>(
    key: string,
    defaultValue: T,
    options?: PersistedStateOptions<T>
): [T, Dispatch<SetStateAction<T>>] {
    const serialize = options?.serialize ?? String;
    const deserialize = options?.deserialize;

    const [value, setValue] = useState<T>(() => {
        const raw = localStorage.getItem(key);
        if (raw == null) {
            return defaultValue;
        }
        if (deserialize) {
            const parsed = deserialize(raw);
            return parsed !== undefined ? parsed : defaultValue;
        }
        return raw as unknown as T;
    });

    useEffect(() => {
        localStorage.setItem(key, serialize(value));
    }, [key, serialize, value]);

    return [value, setValue];
}

/** Convenience serializer/deserializer pair for boolean values. */
export const booleanStorage = {
    serialize: (value: boolean) => String(value),
    deserialize: (raw: string): boolean | undefined =>
        raw === "true" ? true : raw === "false" ? false : undefined,
};

/** Convenience serializer/deserializer pair for integer values. */
export const numberStorage = {
    serialize: (value: number) => String(value),
    deserialize: (raw: string): number | undefined => {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
    },
};

/** Convenience serializer/deserializer pair for JSON string arrays. */
export const stringArrayStorage = {
    serialize: (value: string[]) => JSON.stringify(value),
    deserialize: (raw: string): string[] | undefined => {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return undefined;
            }
            return parsed.filter(
                (entry): entry is string =>
                    typeof entry === "string" && entry.trim().length > 0
            );
        } catch {
            return undefined;
        }
    },
};

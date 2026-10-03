import { vi } from "vitest";

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type Handlers = Record<string, Handler>;

export interface TauriMock {
    /** Every IPC call, in order. */
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    count: (cmd: string) => number;
    argsOf: (cmd: string) => Array<Record<string, unknown>>;
}

/**
 * Installs a fake Tauri IPC bridge so the REAL services/commands wrappers run end to end.
 * Unhandled commands reject (like a backend error); the component under test must cope.
 */
export function installTauriMock(handlers: Handlers): TauriMock {
    const calls: TauriMock["calls"] = [];
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        value: {
            convertFileSrc: (filePath: string) => `asset://localhost/${encodeURIComponent(filePath)}`,
            invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
                calls.push({ cmd, args });
                const handler = handlers[cmd];
                if (!handler) throw new Error(`unmocked command: ${cmd}`);
                return handler(args);
            }),
            transformCallback: () => 0,
            unregisterCallback: () => {},
        },
    });
    return {
        calls,
        count: (cmd) => calls.filter((c) => c.cmd === cmd).length,
        argsOf: (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    };
}

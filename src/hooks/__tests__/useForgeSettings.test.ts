import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useForgeSettings } from "../useForgeSettings";
import * as commands from "../../services/commands";

vi.mock("../../services/commands", () => ({
    getForgeApiKey: vi.fn(),
    setForgeApiKey: vi.fn().mockResolvedValue(undefined),
}));

describe("useForgeSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it("does not call setForgeApiKey when getForgeApiKey fails", async () => {
        vi.mocked(commands.getForgeApiKey).mockRejectedValueOnce(new Error("keyring unavailable"));

        const { result } = renderHook(() => useForgeSettings());

        await waitFor(() => {
            expect(result.current.forgeApiKeyError).not.toBeNull();
        });

        expect(result.current.forgeApiKey).toBe("");
        expect(result.current.isForgeApiKeyLoaded).toBe(false);
        expect(commands.setForgeApiKey).not.toHaveBeenCalled();
    });

    it("does not call setForgeApiKey on initial load when getForgeApiKey succeeds", async () => {
        vi.mocked(commands.getForgeApiKey).mockResolvedValueOnce("existing-key");

        const { result } = renderHook(() => useForgeSettings());

        await waitFor(() => {
            expect(result.current.isForgeApiKeyLoaded).toBe(true);
        });

        expect(result.current.forgeApiKey).toBe("existing-key");
        expect(result.current.forgeApiKeyError).toBeNull();
        expect(commands.setForgeApiKey).not.toHaveBeenCalled();
    });

    it("calls setForgeApiKey only when user explicitly edits the key", async () => {
        vi.mocked(commands.getForgeApiKey).mockResolvedValueOnce("existing-key");

        const { result } = renderHook(() => useForgeSettings());

        await waitFor(() => {
            expect(result.current.isForgeApiKeyLoaded).toBe(true);
        });

        act(() => {
            result.current.setForgeApiKey("new-user-key");
        });

        await waitFor(() => {
            expect(commands.setForgeApiKey).toHaveBeenCalledWith("new-user-key");
        });
    });

    it("allows user to explicitly clear the key", async () => {
        vi.mocked(commands.getForgeApiKey).mockResolvedValueOnce("existing-key");

        const { result } = renderHook(() => useForgeSettings());

        await waitFor(() => {
            expect(result.current.isForgeApiKeyLoaded).toBe(true);
        });

        act(() => {
            result.current.setForgeApiKey("");
        });

        await waitFor(() => {
            expect(commands.setForgeApiKey).toHaveBeenCalledWith("");
        });
    });
});

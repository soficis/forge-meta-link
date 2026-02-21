import { useEffect, useRef, useState } from "react";
import { getForgeApiKey, setForgeApiKey as setForgeApiKeyCommand } from "../services/commands";
import {
    usePersistedState,
    booleanStorage,
    stringArrayStorage,
} from "./usePersistedState";

const LEGACY_FORGE_API_KEY_STORAGE_KEY = "forgeApiKey";

export interface ForgeSettings {
    forgeBaseUrl: string;
    setForgeBaseUrl: (value: string) => void;
    forgeApiKey: string;
    setForgeApiKey: (value: string) => void;
    forgeOutputDir: string;
    setForgeOutputDir: (value: string) => void;
    forgeModelsPath: string;
    setForgeModelsPath: (value: string) => void;
    forgeModelsScanSubfolders: boolean;
    setForgeModelsScanSubfolders: (value: boolean) => void;
    forgeLoraPath: string;
    setForgeLoraPath: (value: string) => void;
    forgeLoraScanSubfolders: boolean;
    setForgeLoraScanSubfolders: (value: boolean) => void;
    forgeSelectedLoras: string[];
    setForgeSelectedLoras: (value: string[]) => void;
    forgeLoraWeight: string;
    setForgeLoraWeight: (value: string) => void;
    forgeIncludeSeed: boolean;
    setForgeIncludeSeed: (value: boolean) => void;
    forgeAdetailerFaceEnabled: boolean;
    setForgeAdetailerFaceEnabled: (value: boolean) => void;
    forgeAdetailerFaceModel: string;
    setForgeAdetailerFaceModel: (value: string) => void;
}

/** Extracts Forge settings (API key stored in Rust-side app data; others in localStorage). */
export function useForgeSettings(): ForgeSettings {
    const [forgeBaseUrl, setForgeBaseUrl] = usePersistedState(
        "forgeBaseUrl",
        "http://127.0.0.1:7860"
    );
    const [forgeApiKey, setForgeApiKeyState] = useState("");
    const [isForgeApiKeyLoaded, setIsForgeApiKeyLoaded] = useState(false);
    const [forgeOutputDir, setForgeOutputDir] = usePersistedState(
        "forgeOutputDir",
        ""
    );
    const [forgeModelsPath, setForgeModelsPath] = usePersistedState(
        "forgeModelsPath",
        ""
    );
    const [forgeModelsScanSubfolders, setForgeModelsScanSubfolders] =
        usePersistedState("forgeModelsScanSubfolders", true, booleanStorage);
    const [forgeLoraPath, setForgeLoraPath] = usePersistedState(
        "forgeLoraPath",
        ""
    );
    const [forgeLoraScanSubfolders, setForgeLoraScanSubfolders] =
        usePersistedState("forgeLoraScanSubfolders", true, booleanStorage);
    const [forgeSelectedLoras, setForgeSelectedLoras] = usePersistedState<
        string[]
    >("forgeSelectedLoras", [], stringArrayStorage);
    const [forgeLoraWeight, setForgeLoraWeight] = usePersistedState(
        "forgeLoraWeight",
        "1.0"
    );
    const [forgeIncludeSeed, setForgeIncludeSeed] = usePersistedState(
        "forgeIncludeSeed",
        true,
        booleanStorage
    );
    const [forgeAdetailerFaceEnabled, setForgeAdetailerFaceEnabled] =
        usePersistedState("forgeAdetailerFaceEnabled", false, booleanStorage);
    const [forgeAdetailerFaceModel, setForgeAdetailerFaceModel] =
        usePersistedState("forgeAdetailerFaceModel", "face_yolov8n.pt");
    const forgeApiKeyPersistQueueRef = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        let cancelled = false;

        const loadForgeApiKey = async () => {
            const legacyApiKey =
                localStorage.getItem(LEGACY_FORGE_API_KEY_STORAGE_KEY) ?? "";
            try {
                const storedApiKey = await getForgeApiKey();
                const resolvedApiKey = storedApiKey || legacyApiKey;

                if (!storedApiKey && legacyApiKey.trim()) {
                    await setForgeApiKeyCommand(legacyApiKey);
                }

                if (!cancelled) {
                    setForgeApiKeyState(resolvedApiKey);
                    setIsForgeApiKeyLoaded(true);
                }
            } catch (error) {
                if (!cancelled) {
                    setForgeApiKeyState(legacyApiKey);
                    setIsForgeApiKeyLoaded(true);
                }
                console.warn("Failed to load Forge API key from backend:", error);
            } finally {
                localStorage.removeItem(LEGACY_FORGE_API_KEY_STORAGE_KEY);
            }
        };

        loadForgeApiKey();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!isForgeApiKeyLoaded) {
            return;
        }

        const nextApiKey = forgeApiKey;
        forgeApiKeyPersistQueueRef.current = forgeApiKeyPersistQueueRef.current
            .catch(() => undefined)
            .then(() => setForgeApiKeyCommand(nextApiKey))
            .catch((error) => {
                console.warn("Failed to persist Forge API key to backend:", error);
            });
    }, [forgeApiKey, isForgeApiKeyLoaded]);

    const setForgeApiKey = (value: string) => {
        setForgeApiKeyState(value);
    };

    return {
        forgeBaseUrl,
        setForgeBaseUrl,
        forgeApiKey,
        setForgeApiKey,
        forgeOutputDir,
        setForgeOutputDir,
        forgeModelsPath,
        setForgeModelsPath,
        forgeModelsScanSubfolders,
        setForgeModelsScanSubfolders,
        forgeLoraPath,
        setForgeLoraPath,
        forgeLoraScanSubfolders,
        setForgeLoraScanSubfolders,
        forgeSelectedLoras,
        setForgeSelectedLoras,
        forgeLoraWeight,
        setForgeLoraWeight,
        forgeIncludeSeed,
        setForgeIncludeSeed,
        forgeAdetailerFaceEnabled,
        setForgeAdetailerFaceEnabled,
        forgeAdetailerFaceModel,
        setForgeAdetailerFaceModel,
    };
}

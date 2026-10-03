import { useEffect, useRef } from "react";

/**
 * Runs `run` once each time `active` flips to true (never again while it stays true, no matter
 * how often `run` changes identity or what state it touches). Always calls the latest `run`.
 *
 * Use it for "refresh when the user opens this tab": an effect that lists the refreshed state in
 * its own dependencies re-triggers itself, which is how the Forge panel ended up refetching in a
 * loop and flickering whenever Forge was unreachable or returned warnings.
 */
export function useRunOncePerActivation(active: boolean, run: () => void): void {
    const runRef = useRef(run);
    useEffect(() => {
        runRef.current = run;
    });
    useEffect(() => {
        if (active) runRef.current();
    }, [active]);
}

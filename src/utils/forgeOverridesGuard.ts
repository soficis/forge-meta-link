/**
 * Decides whether the viewer's Forge payload form should be filled from the loaded image detail.
 *
 * When the user navigates, `currentImage` changes in one render while `currentDetail` still holds
 * the PREVIOUS image's record until its effect clears and reloads it. Filling the form from that
 * stale record, then marking the new image as "populated", left the previous image's prompt,
 * sampler, CFG and seed in the form, and a Send would regenerate with the wrong parameters.
 */
export function shouldPopulateForgeOverrides(args: {
    imageId: number | null | undefined;
    detailId: number | null | undefined;
    populatedForId: number | null;
}): boolean {
    const { imageId, detailId, populatedForId } = args;
    if (imageId == null || detailId == null) return false;
    if (detailId !== imageId) return false;
    return populatedForId !== imageId;
}

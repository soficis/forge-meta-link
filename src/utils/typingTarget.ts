/**
 * True when keyboard input is aimed at something the user types into. Global shortcut handlers
 * (viewer, gallery, app) must ignore those events, otherwise typing "isolation" into a text box
 * toggles info, starts a slideshow, zooms and changes image.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

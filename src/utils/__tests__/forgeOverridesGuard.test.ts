import { describe, it, expect } from "vitest";
import { shouldPopulateForgeOverrides } from "../forgeOverridesGuard";

describe("shouldPopulateForgeOverrides", () => {
    it("fills the form when the loaded detail belongs to the current image", () => {
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: 8, populatedForId: null })).toBe(true);
    });
    it("refuses a stale detail left over from the previously viewed image", () => {
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: 3, populatedForId: null })).toBe(false);
    });
    it("fills once the correct detail arrives after a stale one was skipped", () => {
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: 3, populatedForId: null })).toBe(false);
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: 8, populatedForId: null })).toBe(true);
    });
    it("does not overwrite the user's edits once the image has been populated", () => {
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: 8, populatedForId: 8 })).toBe(false);
    });
    it("does nothing without an image or a detail", () => {
        expect(shouldPopulateForgeOverrides({ imageId: undefined, detailId: 8, populatedForId: null })).toBe(false);
        expect(shouldPopulateForgeOverrides({ imageId: 8, detailId: null, populatedForId: null })).toBe(false);
    });
});

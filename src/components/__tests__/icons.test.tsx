import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TrophyIcon, CrownIcon, BoltIcon, GhostIcon, WarningIcon, BookmarkIcon, GearIcon, PinIcon } from "../icons";

describe("Icon components", () => {
    it("renders decorative icons with aria-hidden=true by default", () => {
        const { container } = render(
            <div>
                <TrophyIcon data-testid="trophy" />
                <CrownIcon data-testid="crown" />
                <BoltIcon data-testid="bolt" />
                <GhostIcon data-testid="ghost" />
                <WarningIcon data-testid="warning" />
                <BookmarkIcon data-testid="bookmark" />
                <GearIcon data-testid="gear" />
                <PinIcon data-testid="pin" />
            </div>
        );

        const svgs = container.querySelectorAll("svg");
        expect(svgs.length).toBe(8);
        svgs.forEach((svg) => {
            expect(svg.getAttribute("aria-hidden")).toBe("true");
            expect(svg.getAttribute("role")).toBeNull();
        });
    });

    it("icon with title exposes role=img and aria-label", () => {
        const { container } = render(
            <div>
                <TrophyIcon title="Winner Trophy" data-testid="trophy-titled" />
                <WarningIcon title="Warning Note" data-testid="warning-titled" />
            </div>
        );

        const svgs = container.querySelectorAll("svg");
        expect(svgs.length).toBe(2);

        expect(svgs[0].getAttribute("role")).toBe("img");
        expect(svgs[0].getAttribute("aria-label")).toBe("Winner Trophy");
        expect(svgs[0].getAttribute("aria-hidden")).toBeNull();
        expect(svgs[0].querySelector("title")?.textContent).toBe("Winner Trophy");

        expect(svgs[1].getAttribute("role")).toBe("img");
        expect(svgs[1].getAttribute("aria-label")).toBe("Warning Note");
        expect(svgs[1].getAttribute("aria-hidden")).toBeNull();
        expect(svgs[1].querySelector("title")?.textContent).toBe("Warning Note");
    });
});

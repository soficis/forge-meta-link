import React from "react";

export interface IconProps extends React.SVGProps<SVGSVGElement> {
    size?: number | string;
    width?: number | string;
    height?: number | string;
    title?: string;
    className?: string;
}

function renderSvg(paths: React.ReactNode, props: IconProps, defaultSize = 16) {
    const {
        size,
        width = size ?? defaultSize,
        height = size ?? defaultSize,
        title,
        className,
        style,
        ...rest
    } = props;

    const ariaProps = title
        ? { role: "img", "aria-label": title }
        : { "aria-hidden": "true" as const };

    return (
        <svg
            width={width}
            height={height}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            style={style}
            {...ariaProps}
            {...rest}
        >
            {title ? <title>{title}</title> : null}
            {paths}
        </svg>
    );
}

export function TrophyIcon(props: IconProps) {
    return renderSvg(
        <>
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
            <path d="M4 4h16v5a8 8 0 0 1-16 0V4z" />
            <path d="M12 17v4" />
            <path d="M8 21h8" />
        </>,
        props
    );
}

export function CrownIcon(props: IconProps) {
    return renderSvg(
        <path d="M3 18h18l-2-12-5 5-2-5-2 5-5-5-2 12z" />,
        props
    );
}

export function BoltIcon(props: IconProps) {
    return renderSvg(
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
        props
    );
}

export function GhostIcon(props: IconProps) {
    return renderSvg(
        <>
            <path d="M9 10h.01" />
            <path d="M15 10h.01" />
            <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
        </>,
        props
    );
}

export function WarningIcon(props: IconProps) {
    return renderSvg(
        <>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </>,
        props
    );
}

export function BookmarkIcon(props: IconProps) {
    return renderSvg(
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />,
        props
    );
}

export function GearIcon(props: IconProps) {
    return renderSvg(
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>,
        props
    );
}

export function PinIcon(props: IconProps) {
    return renderSvg(
        <>
            <line x1="12" y1="17" x2="12" y2="22" />
            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z" />
        </>,
        props
    );
}

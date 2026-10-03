interface HelpOverlayProps {
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; desc: string; group: string }> = [
  { keys: "j / k or → / ←", desc: "Next / Previous image", group: "Navigation" },
  { keys: "f", desc: "Toggle favorite", group: "Navigation" },
  { keys: "Del", desc: "Move to Trash (undo for 6s)", group: "Navigation" },
  { keys: "Shift+Del", desc: "Delete permanently (asks first)", group: "Navigation" },
  { keys: "Ctrl+Z / Cmd+Z", desc: "Undo last delete", group: "Navigation" },
  { keys: "1 – 4", desc: "Pin to Compare Lab slot 1-4", group: "Navigation" },
  { keys: "Esc", desc: "Close viewer / clear selection / close help", group: "Navigation" },
  { keys: "?", desc: "Toggle this help", group: "Navigation" },
  { keys: "0", desc: "Reset zoom / pan (viewer)", group: "Viewer" },
  { keys: "+ / -", desc: "Zoom in / out (viewer)", group: "Viewer" },
  { keys: "i", desc: "Toggle info panel (viewer)", group: "Viewer" },
  { keys: "s", desc: "Toggle slideshow (viewer)", group: "Viewer" },
  { keys: "Ctrl+A", desc: "Select all (gallery)", group: "Gallery" },
  { keys: "Arrow keys / Home / End", desc: "Move between thumbnails (gallery)", group: "Gallery" },
  { keys: "Enter", desc: "Open focused thumbnail (gallery)", group: "Gallery" },
  { keys: "Space", desc: "Select / unselect focused thumbnail (gallery)", group: "Gallery" },
  { keys: "Shift+click / Shift+arrows", desc: "Select a range (gallery)", group: "Gallery" },
  { keys: "Ctrl+click", desc: "Add or remove one image from the selection (gallery)", group: "Gallery" },
  { keys: "Ctrl+F", desc: "Focus search", group: "Gallery" },
];

export function HelpOverlay({ onClose }: HelpOverlayProps) {
  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts help"
      onClick={onClose}
      data-testid="help-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        className="help-overlay-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg, #1a1a1a)",
          color: "inherit",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: 24,
          minWidth: 360,
          maxWidth: 520,
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close help"
            className="viewer-control-button"
            type="button"
            style={{ padding: "4px 10px" }}
          >
            Esc
          </button>
        </div>
        <p style={{ margin: "0 0 12px", opacity: 0.7, fontSize: 13 }}>
          When viewer is open, keys target viewer — otherwise gallery. Inputs are ignored. Press <kbd>?</kbd> to toggle.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys} style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                <td style={{ padding: "6px 8px", fontFamily: "monospace", whiteSpace: "nowrap", fontWeight: 600 }}>{s.keys}</td>
                <td style={{ padding: "6px 8px", opacity: 0.85 }}>{s.desc}</td>
                <td style={{ padding: "6px 8px", opacity: 0.5, fontSize: 12 }}>{s.group}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import type React from "react";

interface AlertCardBodyProps {
  title: string | undefined;
  body: string | undefined;
  /** Max body lines. Longer text is cut; the rest is in the logs. */
  lineClamp: number;
  onDismiss: () => void;
  /** Shows the Retry button when set. */
  onRetry?: () => void;
  /** Cream ink for the title. The pill owns its colors. */
  ink: string;
  /** Alert glyph color. Kept off the live-coral token on purpose. */
  alert: string;
}

/**
 * The inside of a pill alert card: alert disc, title, body and the action
 * row. The caller owns the card surface around it.
 */
export function AlertCardBody({
  title,
  body,
  lineClamp,
  onDismiss,
  onRetry,
  ink,
  alert,
}: AlertCardBodyProps): React.JSX.Element {
  return (
    <>
      <div className="flex items-start" style={{ gap: 10 }}>
        <span
          className="inline-flex items-center justify-center"
          style={{
            width: 20,
            height: 20,
            marginTop: 1,
            borderRadius: "50%",
            background: "rgba(248, 113, 113, 0.16)",
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 3.1v3.3"
              stroke={alert}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
            <circle cx="6" cy="8.7" r="0.85" fill={alert} />
          </svg>
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: 1.2,
              color: ink,
            }}
          >
            {title}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11.5,
              lineHeight: 1.35,
              color: "rgba(245, 241, 228, 0.58)",
              display: "-webkit-box",
              WebkitLineClamp: lineClamp,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {body}
          </div>
        </div>
      </div>

      <div
        className="flex items-center justify-end"
        style={
          {
            gap: 6,
            marginTop: 11,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          className="pill-action pill-action-ghost"
          onClick={onDismiss}
        >
          Dismiss
        </button>
        {onRetry && (
          <button
            type="button"
            className="pill-action pill-action-primary"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
      </div>
    </>
  );
}

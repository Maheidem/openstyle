// Styles for the Remix chat card. The text of REMIX_CHAT_CSS is the same
// as it was in remix-chat.tsx.

const INK = "rgba(245, 241, 228, 0.92)";
export const INK_DIM = "rgba(245, 241, 228, 0.70)";
export const INK_FAINT = "rgba(245, 241, 228, 0.52)";
// Identity/accent color for this floating dark surface — was the retired
// olive brand green (#8AB62A); the new system splits that role into ink
// (--primary) for buttons and accent blue (--sidebar-primary / --ring) for
// identity affordances like this. This component is a fixed dark overlay
// (not theme-aware, see INK above), so it uses the literal dark-mode value
// (#5B8DEF) rather than a CSS var.
const ACCENT = "#5B8DEF";

export const MINI_STRIP_PAD = 24; // .remix-mini[data-full] vertical padding
export const MINI_STRIP_MAX = 316; // main's 340 window cap minus the chrome

export const REMIX_CHAT_CSS = `
  .remix-chat {
    position: relative;
    width: 100%;
    height: 100%;
    font-size: 12.5px;
    color: ${INK};
  }

  .remix-chat-face-strip {
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    transition: opacity 110ms ease, visibility 0s 110ms;
  }
  .remix-chat[data-minimized="true"] .remix-chat-face-strip {
    opacity: 1;
    pointer-events: auto;
    visibility: visible;
    transition: opacity 200ms ease 60ms, visibility 0s;
  }
  .remix-chat-face-full {
    display: flex;
    flex-direction: column;
    min-height: 0;
    opacity: 1;
    visibility: visible;
    transition: opacity 220ms ease 60ms, visibility 0s;
  }
  .remix-chat[data-minimized="true"] .remix-chat-face-full {
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    transition: opacity 110ms ease, visibility 0s 110ms;
  }

  .remix-mini {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 16px 0 13px;
  }
  .remix-mini-dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: ${ACCENT};
  }
  .remix-mini-dot[data-busy="true"] {
    background: #F5F1E4;
    animation: remix-mini-pulse 1.1s ease-in-out infinite;
  }
  .remix-mini-dot[data-failed="true"] { background: rgba(248, 113, 113, 0.9); }
  @keyframes remix-mini-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1); }
  }
  .remix-mini[data-full="true"] {
    align-items: flex-start;
    height: 100%;
    padding: 12px 16px;
  }
  .remix-mini[data-full="true"] .remix-mini-dot { margin-top: 5px; }
  .remix-mini-message {
    flex: 1;
    min-width: 0;
    max-height: ${MINI_STRIP_MAX - MINI_STRIP_PAD}px;
    overflow-y: auto;
    font-size: 12.5px;
    line-height: 1.5;
    color: ${INK_DIM};
  }
  /* No color here — ThinkingShimmer paints via background-clip; color would hide it. */
  .remix-mini-line {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .remix-mini-text { color: ${INK_DIM}; }

  /* No -webkit-app-region:drag — it would swallow leave events for minimize. */
  .remix-chat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 14px 16px 11px;
  }
  .remix-chat-title {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .remix-chat-title svg { flex-shrink: 0; color: ${ACCENT}; }
  .remix-chat-wordmark {
    font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
    font-weight: 500;
    font-size: 20px;
    line-height: 1;
    color: ${INK};
  }
  .remix-chat-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .remix-chat-icon {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 7px;
    background: none;
    color: ${INK_FAINT};
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
  }
  .remix-chat-icon:hover { background: rgba(245, 241, 228, 0.08); color: ${INK}; }

  .remix-chat-scroll { flex: 1; min-height: 0; }
  .remix-chat-thread {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 18px 12px;
  }
  .remix-chat-empty {
    color: ${INK_FAINT};
    line-height: 1.5;
    font-size: 13px;
  }
  .remix-chat ::-webkit-scrollbar { width: 9px; height: 9px; }
  .remix-chat ::-webkit-scrollbar-track { background: transparent; }
  .remix-chat ::-webkit-scrollbar-corner { background: transparent; }
  .remix-chat ::-webkit-scrollbar-thumb {
    background: rgba(245, 241, 228, 0.16);
    border-radius: 99px;
    border: 3px solid transparent;
    background-clip: padding-box;
  }
  .remix-chat ::-webkit-scrollbar-thumb:hover {
    background: rgba(245, 241, 228, 0.28);
    border: 3px solid transparent;
    background-clip: padding-box;
  }
  .remix-chat-user {
    align-self: flex-end;
    max-width: 88%;
    background: rgba(245, 241, 228, 0.13);
    border-radius: 13px 13px 4px 13px;
    padding: 8px 12px;
    line-height: 1.5;
    color: ${INK};
    white-space: pre-wrap;
    word-break: break-word;
  }
  .remix-chat-assistant {
    align-self: stretch;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .remix-chat-activity { font-size: 11.5px; }
  .remix-chat-response { font-size: 13px; }

  .remix-chat-step { display: block; min-width: 0; }
  .remix-chat-step-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: none;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .remix-chat-step-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remix-chat-step-chevron {
    flex-shrink: 0;
    opacity: 0.5;
    transition: transform 140ms ease, opacity 140ms ease;
  }
  .remix-chat-step-head:hover .remix-chat-step-chevron { opacity: 1; }
  .remix-chat-step-chevron[data-open="true"] { transform: rotate(90deg); opacity: 1; }
  .remix-chat-step-body { display: block; padding: 5px 0 3px; }
  .remix-chat-step-key {
    display: block;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: ${INK_FAINT};
    padding: 3px 0 2px;
  }
  .remix-chat-step-pre {
    display: block;
    margin: 0;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(245, 241, 228, 0.08);
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 10px;
    line-height: 1.45;
    color: ${INK_DIM};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 140px;
    overflow-y: auto;
  }

  .remix-chat-action {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 9.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: ${INK_FAINT};
  }
  .remix-chat-action[data-failed="true"] { color: rgba(248, 113, 113, 0.9); }
  .remix-chat-notice {
    font-size: 11px;
    color: rgba(248, 113, 113, 0.95);
    padding: 6px 18px 0;
    line-height: 1.35;
  }

  .remix-chat-busy { font-size: 12px; }

  .remix-chat-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(245, 241, 228, 0.13);
    background: rgba(245, 241, 228, 0.07);
    color: ${INK};
    font-size: 11px;
    line-height: 1;
    padding: 5px 10px;
    border-radius: 999px;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .remix-chat-chip:hover { background: rgba(245, 241, 228, 0.15); }
  .remix-chat-quick {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    padding: 4px 18px 0;
  }
  .remix-chat-composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin: 10px 14px 13px;
    padding: 8px 8px 8px 13px;
    border: 1px solid rgba(245, 241, 228, 0.16);
    background: rgba(245, 241, 228, 0.05);
    border-radius: 14px;
    transition: border-color 140ms ease;
  }
  .remix-chat-composer:focus-within { border-color: rgba(245, 241, 228, 0.34); }
  .remix-chat-input {
    flex: 1;
    resize: none;
    border: none;
    background: transparent;
    color: ${INK};
    font-size: 12.5px;
    line-height: 1.45;
    font-family: inherit;
    outline: none;
    padding: 5px 0;
    min-height: 20px;
    max-height: 120px;
  }
  .remix-chat-input::placeholder { color: ${INK_FAINT}; }
  .remix-chat-send {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 999px;
    background: rgba(245, 241, 228, 0.92);
    color: rgba(24, 22, 18, 0.95);
    cursor: pointer;
    transition: opacity 140ms ease, transform 140ms ease;
  }
  .remix-chat-send svg rect { fill: currentColor; }
  .remix-chat-send:disabled { opacity: 0.3; cursor: default; }
  .remix-chat-send:not(:disabled):hover { transform: scale(1.06); }
  .remix-chat-send:not(:disabled):active { transform: scale(0.95); }

  .remix-md { line-height: 1.6; word-break: break-word; }
  .remix-md > *:first-child { margin-top: 0; }
  .remix-md > *:last-child { margin-bottom: 0; }
  .remix-md p { margin: 0 0 8px; }
  .remix-md h1, .remix-md h2, .remix-md h3, .remix-md h4 {
    margin: 12px 0 6px;
    font-weight: 600;
    line-height: 1.3;
    color: ${INK};
  }
  .remix-md h1 { font-size: 14.5px; }
  .remix-md h2 { font-size: 13.5px; }
  .remix-md h3, .remix-md h4 { font-size: 12.5px; }
  .remix-md ul, .remix-md ol { margin: 0 0 8px; padding-left: 18px; }
  .remix-md li { margin: 2px 0; }
  .remix-md li > ul, .remix-md li > ol { margin-bottom: 0; }
  .remix-md a { color: ${ACCENT}; text-decoration: underline; text-underline-offset: 2px; }
  .remix-md strong { font-weight: 600; color: ${INK}; }
  .remix-md em { font-style: italic; }
  .remix-md code {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    background: rgba(245, 241, 228, 0.1);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .remix-md pre {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(245, 241, 228, 0.08);
    overflow-x: auto;
  }
  .remix-md pre code { background: none; padding: 0; font-size: 10.5px; line-height: 1.5; }
  .remix-md blockquote {
    margin: 0 0 8px;
    padding-left: 11px;
    border-left: 1px solid rgba(245, 241, 228, 0.22);
    color: ${INK_DIM};
  }
  .remix-md hr {
    border: none;
    border-top: 1px solid rgba(245, 241, 228, 0.14);
    margin: 10px 0;
  }
  .remix-md table { border-collapse: collapse; margin: 0 0 8px; font-size: 11.5px; }
  .remix-md th, .remix-md td {
    border: 1px solid rgba(245, 241, 228, 0.16);
    padding: 4px 8px;
    text-align: left;
  }
  .remix-md th { background: rgba(245, 241, 228, 0.06); font-weight: 600; }
`;

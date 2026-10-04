import {
  CANCELLED_MS,
  CHECK_AT_MS,
  CHECK_DRAW_MS,
  CHECK_LEAVE_AT_MS,
  CHECK_PATH_LENGTH,
  CLOSE_DUR_MS,
  DELIVERED_TOTAL_MS,
  INK,
  PILL_SHADOW,
  QUIET_MS,
  STATUS_SLOT,
  SVG_HEIGHT,
} from "./pill-motion";

/** The CSS for the pill, rendered in a style element by the pill page. */
export const PILL_STYLES = `
          /* One easing for every size and position change in the pill, so the
             capsule growing a label and the card taking over read as the same
             piece of motion. Out-of-view surfaces leave faster than the
             incoming one arrives — the swap should feel like a handover, not
             a crossfade of two equals. */
          .pill-layer { pointer-events: none; }

          /* The summon.
             A surface arrives by rising off the screen edge it is anchored to,
             coming up to size with a little overshoot and resolving out of a
             soft blur — three cheap things that together read as the pill
             being conjured rather than switched on. --pill-rise carries the
             direction, so a top-anchored pill drops in and a bottom-anchored
             one lifts.

             Leaving retraces it: back toward the edge, back into the blur,
             but over a shorter distance and a shorter time and with no
             overshoot. Something on its way out shouldn't ask for the
             attention that something arriving does — the exit should be over
             before you have finished looking away from it. */
          .pill-surface {
            opacity: 0;
            transform: scale(0.93)
              translateY(calc(var(--pill-rise, 10px) * 0.55));
            filter: blur(3px);
            transition: opacity 130ms ease,
              transform 170ms cubic-bezier(0.36, 0, 0.66, -0.2),
              filter 130ms ease;
            pointer-events: none;
          }
          .pill-surface[data-show="true"] {
            opacity: 1;
            transform: none;
            filter: blur(0);
            /* An overshoot curve on transform only. Opacity and blur land
               sooner, so the surface is already readable while it is still
               settling — the motion is felt more than watched. */
            transition: opacity 180ms ease,
              transform 380ms cubic-bezier(0.22, 1.12, 0.36, 1),
              filter 220ms ease;
            pointer-events: auto;
          }
          /* Contents follow the surface in, a beat behind and staggered, so
             the card assembles rather than appearing whole. Small distances
             only: this should register as depth, not as a sequence. */
          .pill-rise {
            opacity: 0;
            transform: translateY(5px);
            transition: opacity 160ms ease, transform 160ms ease;
          }
          .pill-surface[data-show="true"] .pill-rise {
            opacity: 1;
            transform: none;
            transition: opacity 240ms ease,
              transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
          }
          .pill-surface[data-show="true"] .pill-rise-1 { transition-delay: 50ms; }
          .pill-surface[data-show="true"] .pill-rise-2 { transition-delay: 95ms; }

          /* The chat surface morphs between the one-line strip and the full
             card, so size and shape join the transition — hover-expand should
             read as the strip growing into the conversation, not as one
             surface being swapped for another. */
          .pill-card.pill-chat-morph,
          .pill-card.pill-chat-morph[data-show="true"] {
            transition: opacity 180ms ease,
              transform 380ms cubic-bezier(0.22, 1.12, 0.36, 1),
              filter 220ms ease,
              width 320ms cubic-bezier(0.3, 0.9, 0.3, 1),
              height 320ms cubic-bezier(0.3, 0.9, 0.3, 1),
              border-radius 320ms cubic-bezier(0.3, 0.9, 0.3, 1);
          }

          /* ---- Remix card ---- */

          /* A column whose order follows the anchored edge, so the waveform
             always ends up against the edge that stays still while the window
             grows — which is what lets the bars hold their position on screen
             as the capsule becomes the box. */
          .pill-remix-body {
            display: flex;
            flex-direction: column;
            gap: 9px;
          }
          .pill-remix-body[data-anchor="start"] {
            flex-direction: column-reverse;
          }

          /* The bars keep the capsule's own width and height. Only the room
             around them changes. */
          .pill-remix-wave {
            display: flex;
            justify-content: center;
            height: ${SVG_HEIGHT}px;
          }

          .pill-remix-brand {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-size: 12.5px;
            font-weight: 600;
            letter-spacing: 0.01em;
            color: rgba(245, 241, 228, 0.92);
          }
          .pill-remix-brand svg { color: rgba(245, 241, 228, 0.85); }

          .pill-remix-transcript {
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            overflow: hidden;
            min-height: 16px;
            max-height: 47px;
            font-size: 11.5px;
            line-height: 1.35;
            color: rgba(245, 241, 228, 0.72);
          }
          .pill-remix-transcript span {
            white-space: normal;
            overflow-wrap: break-word;
          }
          .pill-remix-transcript[data-empty="true"] {
            justify-content: center;
            align-items: center;
            color: rgba(245, 241, 228, 0.42);
          }

          /* The capsule keeps its enter/exit motion on the shared .pill-surface
             summon above; .pill-capsule only carries the completion states
             (delivered / cancelled / quiet) and the hover lift, so it must not
             set an enter transform of its own — that would fight the summon. */
          .pill-capsule {
            position: relative;
            box-shadow: ${PILL_SHADOW};
          }

          .pill-capsule[data-exit="cancelled"],
          .pill-capsule[data-exit="quiet"] {
            opacity: 0;
            pointer-events: none;
            transition: opacity ${CANCELLED_MS}ms ease,
                        transform ${CANCELLED_MS}ms cubic-bezier(0.4, 0, 1, 1);
          }
          .pill-capsule[data-exit="cancelled"] { transform: scale(0.7) translateY(4px); }
          .pill-capsule[data-exit="quiet"] {
            transform: scale(0.76);
            transition-duration: ${QUIET_MS}ms;
          }

          @keyframes pill-delivered {
            0%, ${(CHECK_LEAVE_AT_MS / DELIVERED_TOTAL_MS) * 100}% {
              opacity: 1;
              transform: scale(1);
            }
            100% {
              opacity: 0;
              transform: scale(0.94);
            }
          }
          .pill-capsule[data-exit="delivered"] {
            animation: pill-delivered ${DELIVERED_TOTAL_MS}ms linear forwards;
            pointer-events: none;
          }

          @keyframes pill-bar-collapse {
            from { transform: scaleY(1); }
            to { transform: scaleY(0); }
          }
          .pill-capsule[data-exit="delivered"] [data-bars] line {
            transform-origin: 50% 50%;
            animation: pill-bar-collapse ${CLOSE_DUR_MS}ms cubic-bezier(0.4, 0, 1, 1)
              var(--close-delay) both;
          }

          @media (hover: hover) and (pointer: fine) {
            .pill-capsule[data-show="true"]:not([data-exit]):hover {
              transform: translateY(-1px);
              border-color: rgba(255, 255, 255, 0.16);
              transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1),
                          border-color 140ms ease;
            }
          }

          @keyframes pill-check-fade { from { opacity: 0; } to { opacity: 1; } }
          @keyframes pill-check-draw {
            from { stroke-dashoffset: ${CHECK_PATH_LENGTH}; }
            to { stroke-dashoffset: 0; }
          }
          .pill-check {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
          }
          .pill-capsule[data-exit="delivered"] .pill-check {
            animation: pill-check-fade 80ms ease ${CHECK_AT_MS}ms both;
          }
          .pill-capsule[data-exit="delivered"] .pill-check path {
            animation: pill-check-draw ${CHECK_DRAW_MS}ms cubic-bezier(0.22, 1, 0.36, 1)
              ${CHECK_AT_MS}ms both;
          }

          .pill-card {
            border-radius: 20px;
            transition: opacity 140ms ease,
                        transform 140ms cubic-bezier(0.4, 0, 1, 1),
                        border-radius 140ms ease;
          }
          .pill-card[data-show="false"] {
            transform: scale(0.32, 0.34);
            border-radius: 60px;
          }
          .pill-card[data-show="true"] {
            transition: opacity 180ms ease,
                        transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
                        border-radius 300ms cubic-bezier(0.22, 1, 0.36, 1);
          }

          /* The status mark's slot, opening from the capsule's right end the
             same way the cancel slot opens from its left. */
          .pill-status {
            width: 0;
            opacity: 0;
            overflow: hidden;
            flex-shrink: 0;
            transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease;
          }
          .pill-status[data-open="true"] {
            width: ${STATUS_SLOT}px;
            opacity: 1;
          }
          .pill-status-mark {
            transform: scale(0.7);
            transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
          }
          .pill-status[data-open="true"] .pill-status-mark { transform: none; }

          /* Progress has no percentage to show and no text to read, so the
             turning ring is the whole message: something is still happening. */
          @keyframes pill-spin { to { transform: rotate(360deg); } }
          .pill-spinner {
            transform-origin: 50% 50%;
            animation: pill-spin 900ms linear infinite;
          }

          /* No chip behind the mark — it sits directly on the capsule, and
             reads as part of it. The button keeps its box as a hit target;
             only the glyph is drawn. */
          .pill-cancel {
            background: none;
            border: 0;
            transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1);
          }
          .pill-cancel:active { transform: scale(0.86); }
          /* Resting dim enough to sit alongside the quiet bars, full strength
             under the cursor so it's clearly the thing you're about to hit. */
          .pill-cancel-glyph { transition: opacity 140ms ease; }

          .pill-action {
            border: 0;
            border-radius: 999px;
            height: 26px;
            padding: 0 12px;
            font-size: 11.5px;
            font-weight: 500;
            line-height: 1;
            letter-spacing: 0.005em;
            cursor: default;
            transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
          }
          .pill-action:active { transform: scale(0.97); }
          .pill-action-ghost {
            background: transparent;
            color: rgba(245, 241, 228, 0.6);
          }
          .pill-action-primary {
            background: ${INK};
            color: #1D2129;
          }

          @media (hover: hover) and (pointer: fine) {
            .pill-cancel:hover .pill-cancel-glyph { opacity: 1; }
            .pill-action-ghost:hover {
              background: rgba(245, 241, 228, 0.1);
              color: rgba(245, 241, 228, 0.88);
            }
            .pill-action-primary:hover { background: #FFFDF5; }
          }

          @media (prefers-reduced-motion: reduce) {
            /* Keep the fade, drop the travel, the overshoot and the blur —
               those are the parts that provoke. */
            .pill-surface,
            .pill-surface[data-show="true"] {
              transform: none !important;
              filter: none !important;
            }
            .pill-rise,
            .pill-surface[data-show="true"] .pill-rise {
              transform: none !important;
              transition-delay: 0ms !important;
            }
            .pill-surface,
            .pill-surface[data-show="true"],
            .pill-rise,
            .pill-capsule[data-exit],
            .pill-card,
            .pill-card[data-show="true"],
            .pill-status,
            .pill-status-mark,
            .pill-cancel,
            .pill-action { transition-duration: 1ms !important; }
            .pill-capsule[data-exit],
            .pill-capsule[data-show="true"] [data-bars] line,
            .pill-capsule[data-exit] [data-bars] line,
            .pill-capsule[data-exit] .pill-check,
            .pill-capsule[data-exit] .pill-check path {
              animation-duration: 1ms !important;
              animation-delay: 0ms !important;
            }
            .pill-card[data-show="false"] { transform: none; border-radius: 20px; }
            .pill-capsule { transform: none; }
            /* A spinner that doesn't turn says nothing, so slow it rather
               than stopping it. */
            .pill-spinner { animation-duration: 2.4s; }
          }
        `;

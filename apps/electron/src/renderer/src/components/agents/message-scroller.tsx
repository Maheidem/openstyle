"use client";

import { cn } from "@renderer/lib/utils";
import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  followOutput?: boolean;
  followThreshold?: number;
  smooth?: boolean;
  label?: string;
  busy?: boolean;
  contentClassName?: string;
  viewportRef?: Ref<HTMLElement>;
}

export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  label = "Conversation",
  busy,
  contentClassName,
  viewportRef: externalViewportRef,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(
      () => {
        programmaticScrollRef.current = false;
      },
      behavior === "smooth" ? 320 : 0,
    );
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || programmaticScrollRef.current) return;

    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    followingRef.current = distance <= followThreshold;
  }, [followThreshold]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
  }, []);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    if (!followOutput) return;

    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [followOutput, scrollToEnd]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (!followOutput || !followingRef.current) return;
      scrollToEnd(reduce || !smooth ? "auto" : "smooth");
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [followOutput, reduce, scrollToEnd, smooth]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("min-h-0", className)}
      {...props}
    >
      <section
        ref={setViewportRef}
        aria-label={label}
        onScroll={handleScroll}
        onWheel={leaveLiveEdge}
        onTouchStart={leaveLiveEdge}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
            leaveLiveEdge();
          }
        }}
        className="h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [scrollbar-gutter:stable]"
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={busy}
          className={contentClassName}
        >
          {children}
        </div>
      </section>
    </div>
  );
}

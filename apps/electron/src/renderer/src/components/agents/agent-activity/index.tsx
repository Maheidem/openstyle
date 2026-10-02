"use client";

import { AgentDisclosure } from "@renderer/components/agents/agent-disclosure";
import { ThinkingShimmer } from "@renderer/components/agents/loading-states/thinking-shimmer";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@renderer/lib/ease";
import { cn } from "@renderer/lib/utils";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { StepRow } from "./activity-row";
import type { AgentActivityProps } from "./types";

export function AgentActivity({
  items,
  status = "working",
  activeLabel,
  summary,
  maxHeight = 208,
  className,
  contentClassName,
}: AgentActivityProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const [contentHeight, setContentHeight] = useState(0);
  const [currentOpen, setOpen] = useState(false);
  const working = status === "working";
  const expanded = working || currentOpen;
  const cappedHeight = Math.min(contentHeight, Math.max(0, maxHeight));
  const viewportHeight = working ? Math.max(0, maxHeight) : cappedHeight;
  const capped = contentHeight > maxHeight;
  const streamOffset = working
    ? Math.min(0, viewportHeight - contentHeight)
    : 0;

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const measure = () => setContentHeight(node.offsetHeight);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousStatus.current === "working" && status === "complete") {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [status]);

  const toggle = () => {
    const next = !currentOpen;
    setOpen(next);
    if (next)
      requestAnimationFrame(() => viewportRef.current?.scrollTo({ top: 0 }));
  };

  const maskImage = capped
    ? working
      ? "linear-gradient(to bottom, transparent, black 12px)"
      : "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)"
    : undefined;

  return (
    <div
      data-state={working ? "working" : expanded ? "open" : "closed"}
      aria-busy={working}
      className={cn("w-full text-sm", className)}
    >
      {working ? (
        <div
          id={triggerId}
          role="status"
          className="flex h-7 min-w-0 items-center text-muted-foreground"
        >
          <ThinkingShimmer>{activeLabel ?? "Thinking…"}</ThinkingShimmer>
        </div>
      ) : (
        <button
          id={triggerId}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
          className="group flex h-7 min-w-0 items-center gap-1.5 rounded-md text-left font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="truncate">{summary}</span>
          <m.span
            aria-hidden="true"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="inline-flex shrink-0 text-muted-foreground/70 group-hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </m.span>
        </button>
      )}

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={expanded}
        openHeight={viewportHeight}
      >
        <div
          ref={viewportRef}
          className={cn(
            "scrollbar-hide pr-1",
            capped && expanded && !working
              ? "overflow-y-auto"
              : "overflow-y-hidden",
          )}
          style={{
            height: viewportHeight,
            maskImage,
            WebkitMaskImage: maskImage,
          }}
        >
          <m.div
            ref={contentRef}
            role="list"
            initial={false}
            animate={{ y: streamOffset }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className={cn("space-y-0.5 py-2", contentClassName)}
          >
            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <m.div
                  layout="position"
                  key={item.id}
                  role="listitem"
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : {
                          opacity: { duration: 0.18, ease: EASE_OUT },
                          y: SPRING_LAYOUT,
                          layout: SPRING_LAYOUT,
                        }
                  }
                >
                  <StepRow item={item} />
                </m.div>
              ))}
            </AnimatePresence>
          </m.div>
        </div>
      </AgentDisclosure>
    </div>
  );
}

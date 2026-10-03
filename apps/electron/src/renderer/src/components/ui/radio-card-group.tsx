"use client";

import { cn } from "@renderer/lib/utils";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type * as React from "react";

// Radix gives the arrow keys (they move focus and select), one tab stop and
// aria-checked. Radix moves only focus on Home and End. This group also
// selects the first or last card, to match the arrow keys.
function RadioCardGroup({
  onKeyDown,
  onValueChange,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>): React.JSX.Element {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]:not(:disabled)',
      ),
    );
    const target = event.key === "Home" ? items[0] : items.at(-1);
    if (!target) return;
    event.preventDefault();
    onValueChange?.(target.value);
    target.focus();
  };

  return (
    <RadioGroupPrimitive.Root
      {...props}
      onValueChange={onValueChange}
      onKeyDown={handleKeyDown}
    />
  );
}

// The card carries the "group" class. Children style the checked state with
// the group-data-[state=checked] variant.
function RadioCard({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        "group border-border bg-card relative overflow-hidden rounded-lg border text-left transition-all duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
        "hover:border-foreground/20 hover:bg-card/90",
        "data-[state=checked]:border-primary/40 data-[state=checked]:bg-accent/45",
        className,
      )}
      {...props}
    />
  );
}

export { RadioCard, RadioCardGroup };

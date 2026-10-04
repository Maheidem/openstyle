import { useEffect, useRef } from "react";

/**
 * Focus and select a search input when the user presses Cmd+K or Ctrl+K.
 * Attach the returned ref to the input. When `enabled` is false, the
 * shortcut does nothing.
 */
export function useSearchShortcut(
  enabled: boolean,
): React.RefObject<HTMLInputElement | null> {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);

  return inputRef;
}

import { useCallback, useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1500;

/**
 * Copy text to the clipboard and report a short-lived "copied" flag for the
 * button check mark. The reset timer is cleared on unmount and on each new
 * copy, so an old timer never cuts a newer "copied" state short.
 */
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, []);

  return { copied, copy };
}

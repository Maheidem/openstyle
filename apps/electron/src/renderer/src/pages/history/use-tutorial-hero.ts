import { KNOWN_NOTIFICATION_KEYS } from "@openstyle/validations";
import { useDismissible } from "@renderer/hooks/use-dismissible";
import { usePersistentBool } from "@renderer/hooks/use-persistent-state";
import { useCallback, useEffect, useRef } from "react";

/** Dismiss state of the tutorial hero on the History page. */
export function useTutorialHero(): {
  heroReady: boolean;
  heroDismissed: boolean;
  dismissHero: () => void;
  setShowTutorial: (value: boolean) => void;
} {
  // Keep the legacy localStorage flag as a synchronous compatibility mirror:
  // it prevents a flash for users who dismissed the hero before the SQLite
  // store existed and preserves their choice if the migration PUT fails.
  const [legacyHeroDismissed, setLegacyHeroDismissed] = usePersistentBool(
    "today.heroDismissed",
    false,
  );
  const {
    dismissed: storedHeroDismissed,
    dismiss: persistHeroDismissal,
    reset: resetStoredHeroDismissal,
    ready: heroReady,
  } = useDismissible(KNOWN_NOTIFICATION_KEYS.TODAY_TUTORIAL_HERO);
  const heroDismissed = storedHeroDismissed || legacyHeroDismissed;
  const migrationAttemptedRef = useRef(false);

  // Best-effort one-time migration per mount. The legacy mirror is deliberately
  // retained until the user explicitly resets the tutorial; if this PUT fails,
  // the old dismissal still survives and migration retries next app launch.
  useEffect(() => {
    if (
      !heroReady ||
      storedHeroDismissed ||
      !legacyHeroDismissed ||
      migrationAttemptedRef.current
    ) {
      return;
    }
    migrationAttemptedRef.current = true;
    persistHeroDismissal();
  }, [
    heroReady,
    storedHeroDismissed,
    legacyHeroDismissed,
    persistHeroDismissal,
  ]);

  const dismissHero = useCallback(() => {
    setLegacyHeroDismissed(true);
    persistHeroDismissal();
  }, [persistHeroDismissal, setLegacyHeroDismissed]);

  const resetHero = useCallback(() => {
    setLegacyHeroDismissed(false);
    resetStoredHeroDismissal();
  }, [resetStoredHeroDismissal, setLegacyHeroDismissed]);

  const setShowTutorial = useCallback(
    (value: boolean) => {
      if (value) resetHero();
      else dismissHero();
    },
    [dismissHero, resetHero],
  );

  return { heroReady, heroDismissed, dismissHero, setShowTutorial };
}

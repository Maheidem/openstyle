/**
 * E2E seam for Meeting Mode. With OPENSTYLE_E2E=1 and
 * OPENSTYLE_E2E_FAKE_MEETING_CAPTURE=1, the recorder writes silence to both
 * tracks. It opens no audio device, starts no native helper and runs no
 * permission probe, so no macOS privacy dialog can appear. This also lets a
 * Linux CI run record a meeting. A run without OPENSTYLE_E2E=1 ignores the
 * flag.
 */
export function isFakeMeetingCapture(): boolean {
  return (
    process.env.OPENSTYLE_E2E === "1" &&
    process.env.OPENSTYLE_E2E_FAKE_MEETING_CAPTURE === "1"
  );
}

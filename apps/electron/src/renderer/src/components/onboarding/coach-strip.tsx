import {
  type CoachPhase,
  Keycap,
  Wave,
} from "@renderer/components/hotkey-demo";
import { cn } from "@renderer/lib/utils";

// ---------------------------------------------------------------------------
// Coach strip — the keycap sentence, status dot, and live waveform shared by
// onboarding's draft and remix steps. Extracted from tutorial-demo.tsx and
// parameterized by which key events drive it (dictation vs remix hotkey).
// ---------------------------------------------------------------------------

export function CoachStrip({
  keys,
  phase,
  lead,
  instructionPrefix,
  instructionSuffix,
  sayText,
  statusLabel,
  statusEmphasis,
  getLiveLevel,
  children,
}: {
  keys: string[];
  phase: CoachPhase;
  /** Optional context line above the instruction (e.g. "keep it highlighted"). */
  lead?: React.ReactNode;
  /** Instruction sentence around the inline keycaps:
   * "{prefix} [keys] {suffix}" — e.g. "Click into the email, hold [Fn] and say:". */
  instructionPrefix: string;
  instructionSuffix: string;
  /** The exact words the user should speak, shown as a quote. */
  sayText: string;
  statusLabel: string;
  statusEmphasis: boolean;
  getLiveLevel: () => number | null;
  children?: React.ReactNode;
}): React.JSX.Element {
  const pressed = phase === "pressed";
  return (
    <div className="flex w-full flex-col gap-4">
      {lead && (
        <p className="text-muted-foreground text-[14px] leading-relaxed">
          {lead}
        </p>
      )}

      <p className="text-foreground text-[14.5px] leading-[2]">
        {instructionPrefix}{" "}
        <span className="inline-block align-middle whitespace-nowrap">
          {keys.map((tok, i) => (
            <span key={`${tok}-${i}`} className="inline-block align-middle">
              {i > 0 && (
                <span className="text-muted-foreground mx-1 text-[13px]">
                  +
                </span>
              )}
              <Keycap pressed={pressed} label={tok} size={28} />
            </span>
          ))}
        </span>{" "}
        {instructionSuffix}
      </p>

      <div
        className={cn(
          "rounded-[12px] border px-4 py-3 transition-colors duration-200",
          pressed ? "border-primary bg-accent" : "border-border bg-card",
        )}
      >
        <p
          className={cn(
            "text-[16px] leading-relaxed font-medium transition-colors",
            pressed ? "text-accent-foreground" : "text-foreground",
          )}
        >
          "{sayText}"
        </p>
      </div>

      <div
        className={cn(
          "relative w-full overflow-hidden rounded-[12px] border px-5 py-3.5 transition-colors duration-200",
          pressed ? "border-primary bg-accent" : "border-border bg-sidebar",
        )}
      >
        <div className="mb-1.5 flex items-center gap-2.5">
          <span
            className={cn(
              "h-[7px] w-[7px] rounded-full transition-all duration-200",
              statusEmphasis
                ? "bg-primary opacity-100"
                : "bg-muted-foreground opacity-40",
            )}
            style={
              pressed ? { animation: "tdot 1.6s infinite ease-in-out" } : {}
            }
          />
          <span
            className={cn(
              "mono text-[10px] font-semibold tracking-[0.16em] uppercase transition-colors",
              statusEmphasis
                ? "text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </div>
        <Wave pressed={pressed} getLiveLevel={getLiveLevel} height={44} />
      </div>

      {children}
    </div>
  );
}

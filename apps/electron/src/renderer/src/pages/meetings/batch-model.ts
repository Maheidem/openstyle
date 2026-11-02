import type { MeetingBatchState } from "@openstyle/validations";

/** The batch rail shows a running batch always, and a finished batch until
 * the user closes it. `closedId` is the id of the batch that the user closed
 * (kept in localStorage, so it survives a tab change and a restart). */
export function isBatchShown(
  state: MeetingBatchState | undefined,
  closedId: string,
): boolean {
  return (
    state !== undefined &&
    state.total > 0 &&
    (state.active || closedId !== state.id)
  );
}

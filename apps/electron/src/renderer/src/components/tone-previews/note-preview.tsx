// A neutral "typed into any field" preview for the Everything else group, where
// the destination surface is unknown. Deliberately plainer than the chat/email
// previews so it doesn't imply a specific app.
export function NotePreview({ sample }: { sample: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <p className="text-foreground text-[14px] leading-[1.5]">{sample}</p>
    </div>
  );
}

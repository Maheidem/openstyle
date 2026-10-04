export function WorkChatPreview({
  sample,
  sender,
  time,
}: {
  sample: string;
  sender: string;
  time: string;
}): React.JSX.Element {
  return (
    <div className="w-full rounded-lg border border-border bg-card px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[11px] font-semibold text-secondary-foreground">
          {sender.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-[13px] font-semibold">
              {sender}
            </span>
            <span className="text-muted-foreground text-[10.5px] font-medium">
              {time}
            </span>
          </div>
          <p className="text-foreground mt-1.5 text-[14px] leading-[1.5] break-words">
            {sample}
          </p>
        </div>
      </div>
    </div>
  );
}

export function TextMessagePreview({
  sample,
}: {
  sample: string;
}): React.JSX.Element {
  return (
    <div className="bg-background/75 rounded-lg border border-border/80 px-3 py-3">
      <div className="flex justify-end">
        <div className="relative max-w-[27ch] rounded-[20px] border border-border bg-card px-4 py-3 text-[14px] leading-[1.45] text-foreground shadow-none">
          <span
            aria-hidden="true"
            className="absolute right-[-5px] bottom-3 h-3 w-3 rotate-45 rounded-[3px] border border-border bg-card"
          />
          <span className="relative block">{sample}</span>
        </div>
      </div>
    </div>
  );
}

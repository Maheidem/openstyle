// A single "what lands" example for a cleanup level. The raw transcript is no
// longer shown per card — the Off card's untouched text is the baseline, and
// each higher level shows a progressively cleaner result.
export function CleanupPreview({
  result,
}: {
  result: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/70 bg-background/60 px-3.5 py-3">
      <p className="text-foreground text-[13px] leading-[1.5]">{result}</p>
    </div>
  );
}

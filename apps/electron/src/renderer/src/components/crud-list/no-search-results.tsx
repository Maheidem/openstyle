/** Centered message for a list with no rows. The page passes the text. */
export function NoSearchResults({
  message,
}: {
  message: string;
}): React.JSX.Element {
  return (
    <div className="text-muted-foreground py-10 text-center">
      <span className="display text-[20px]">{message}</span>
    </div>
  );
}

import { Button } from "@renderer/components/ui/button";

export function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      title={title}
      className="shrink-0"
    >
      {children}
    </Button>
  );
}

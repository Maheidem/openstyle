import { DragSpacer } from "@renderer/components/drag-spacer";
import { cn } from "@renderer/lib/utils";

// ---------------------------------------------------------------------------
// PageShell: a draggable topbar and a padded scroll area. The tone, help and
// models pages use it.
// ---------------------------------------------------------------------------

export function PageShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      <div className="responsive-page-scroll flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageHeader — editorial title with italic accent
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.JSX.Element {
  return (
    <div className="mb-7 flex items-end justify-between gap-4">
      <div>
        <h1 className="display text-foreground m-0 flex items-baseline gap-3 text-[32px] font-medium leading-tight tracking-[-0.02em]">
          <span>{title}</span>
        </h1>
        {subtitle && (
          <p className="text-muted-foreground mt-1 max-w-[480px] text-[13px] leading-[1.5]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Eyebrow — small section label shared across settings pages
// ---------------------------------------------------------------------------

export function Eyebrow({
  text,
  accent,
}: {
  text: string;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <span className={cn("eyebrow", accent && "eyebrow-accent")}>{text}</span>
  );
}

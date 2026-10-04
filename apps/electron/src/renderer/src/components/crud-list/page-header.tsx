export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.JSX.Element {
  return (
    <div className="mb-7">
      <h1 className="display text-foreground m-0 text-[32px] font-medium leading-tight tracking-[-0.02em]">
        {title}
      </h1>
      {subtitle && (
        <p className="text-muted-foreground mt-1 max-w-[480px] text-[13px] leading-[1.5]">
          {subtitle}
        </p>
      )}
    </div>
  );
}

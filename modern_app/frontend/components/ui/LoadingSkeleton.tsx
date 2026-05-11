export function LoadingSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-11 animate-pulse rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900"
        />
      ))}
    </div>
  );
}

export function LoadingCard({ className = "" }: { className?: string }) {
  return (
    <div
      className={`h-28 animate-pulse rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    />
  );
}

export function LoadingGrid({ items = 6, className = "" }: { items?: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: items }).map((_, i) => (
        <LoadingCard key={i} />
      ))}
    </div>
  );
}

"use client";

export function ErrorState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-4">
      <h3 className="text-sm font-semibold text-rose-200">{title}</h3>
      <p className="mt-1 text-sm text-rose-100/80">{description}</p>
      {onRetry ? <button className="btn mt-3" onClick={onRetry}>Reintentar</button> : null}
    </div>
  );
}

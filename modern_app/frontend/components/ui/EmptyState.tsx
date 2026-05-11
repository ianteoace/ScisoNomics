import { CircleHelp } from "lucide-react";

export function EmptyState({ title, hint, ctaLabel, onAction }: { title: string; hint: string; ctaLabel?: string; onAction?: () => void }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center" style={{ borderColor: "rgb(var(--line))" }}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-800/50">
        <CircleHelp size={18} />
      </div>
      <p className="text-lg font-semibold">{title}</p>
      <p className="mt-1 text-sm" style={{ color: "rgb(var(--muted))" }}>{hint}</p>
      {ctaLabel ? <button className="btn mt-4" onClick={onAction}>{ctaLabel}</button> : null}
    </div>
  );
}

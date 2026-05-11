import { LoaderCircle } from "lucide-react";

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center gap-2 text-sm text-slate-400"><LoaderCircle className="animate-spin" size={14} /> Cargando datos...</div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-800/35" />
        ))}
      </div>
    </div>
  );
}

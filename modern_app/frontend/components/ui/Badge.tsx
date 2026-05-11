export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "income" | "expense" | "warn" }) {
  const cls =
    tone === "income"
      ? "bg-emerald-900/35 text-emerald-300"
      : tone === "expense"
      ? "bg-rose-900/35 text-rose-300"
      : tone === "warn"
      ? "bg-amber-900/35 text-amber-300"
      : "bg-slate-800/60 text-slate-300";
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

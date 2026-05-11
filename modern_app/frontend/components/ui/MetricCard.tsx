import { motion } from "framer-motion";

export function MetricCard({ title, value, helper, tone = "default", highlightOnHover = false }: { title: string; value: string; helper?: string; tone?: "default" | "income" | "expense" | "warn" | "accent"; highlightOnHover?: boolean }) {
  const toneClass =
    tone === "income" ? "text-emerald-400" : tone === "expense" ? "text-rose-400" : tone === "warn" ? "text-amber-400" : tone === "accent" ? "text-aqua" : "text-slate-100";

  return (
    <motion.article whileHover={{ y: -2 }} transition={{ duration: 0.15 }} className={`card p-5 transition-colors duration-200 ${highlightOnHover ? "hover:border-slate-300 dark:hover:border-white/40" : "hover:border-slate-300 dark:hover:border-white/30"}`}>
      <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
      <p className={`metric-number mt-2 ${toneClass}`}>{value}</p>
      {helper ? <p className="mt-1 text-xs text-slate-400">{helper}</p> : null}
    </motion.article>
  );
}

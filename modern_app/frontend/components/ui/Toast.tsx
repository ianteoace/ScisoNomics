export function Toast({ type, message }: { type: "success" | "error"; message: string }) {
  return (
    <div className={`fixed bottom-4 right-4 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${type === "success" ? "border-emerald-500 bg-emerald-900/90 text-emerald-100" : "border-rose-500 bg-rose-900/90 text-rose-100"}`}>
      {message}
    </div>
  );
}

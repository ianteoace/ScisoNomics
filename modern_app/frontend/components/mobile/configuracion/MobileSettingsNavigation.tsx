import { ChevronRight } from "lucide-react";
import type { SettingsSectionId } from "../../../lib/settings";

export type MobileSettingsId = SettingsSectionId | "quick-entry" | "recovery" | "legal";
export const MOBILE_SETTINGS_GROUPS: { title: string; rows: { id: MobileSettingsId; title: string; subtitle?: string; androidOnly?: boolean }[] }[] = [
  { title: "General", rows: [
    { id: "general", title: "Preferencias generales", subtitle: "Tema y guías" },
    { id: "quick-entry", title: "Accesos rápidos de Android", subtitle: "Ingreso y gasto desde Ajustes rápidos", androidOnly: true },
    { id: "datos", title: "Datos y backups", subtitle: "Almacenamiento en este dispositivo" },
  ] },
  { title: "Cuenta y seguridad", rows: [
    { id: "cuenta", title: "Cuenta" },
    { id: "dispositivos", title: "Dispositivos confiables", subtitle: "Seguridad de tu cuenta" },
    { id: "recovery", title: "Recuperación de cuenta" },
    { id: "diagnostico", title: "Integridad y protección", subtitle: "Estado del almacenamiento local" },
  ] },
  { title: "Sincronización", rows: [{ id: "sync", title: "Sincronización" }] },
  { title: "Premium y facturación", rows: [{ id: "suscripcion", title: "Premium" }] },
  { title: "Información", rows: [
    { id: "acerca", title: "Acerca de ScisoNomics" },
    { id: "legal", title: "Legal y privacidad", subtitle: "Términos, privacidad y soporte" },
    { id: "actualizaciones", title: "Actualizaciones", subtitle: "Distribución de la aplicación" },
  ] },
];

export function mobileSettingsFromUrl(search: string, android: boolean): MobileSettingsId | null {
  const params = new URLSearchParams(search);
  if (params.get("panel") === "cuenta") return "cuenta";
  const id = params.get("section");
  return MOBILE_SETTINGS_GROUPS.flatMap(group => group.rows).find(row => row.id === id && (!row.androidOnly || android))?.id ?? null;
}

export function MobileSettingsNavigation({ android, summaries, recoveryPending, onSelect }: {
  android: boolean; summaries: Partial<Record<MobileSettingsId, string>>; recoveryPending: boolean; onSelect: (id: MobileSettingsId) => void;
}) {
  return <nav aria-label="Secciones de configuración" className="grid min-w-0 gap-5">
    {MOBILE_SETTINGS_GROUPS.map(group => <section key={group.title} className="min-w-0" aria-label={group.title}>
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{group.title}</h2>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-slate-900/60 divide-y divide-white/10">
        {group.rows.filter(row => !row.androidOnly || android).map(row => <button key={row.id} type="button" data-settings-row={row.id}
          className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3 py-3 text-left hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-cyan-400"
          onClick={() => onSelect(row.id)}>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-[15px] font-medium text-slate-100">{row.title}</span>
            {(summaries[row.id] || row.subtitle) ? <span className="mt-0.5 block break-words text-xs leading-5 text-slate-400">{summaries[row.id] || row.subtitle}</span> : null}
          </span>
          {row.id === "recovery" && recoveryPending ? <span className="shrink-0 rounded-md bg-amber-400/10 px-2 py-1 text-xs text-amber-200">Pendiente</span> : null}
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-500" />
        </button>)}
      </div>
    </section>)}
  </nav>;
}

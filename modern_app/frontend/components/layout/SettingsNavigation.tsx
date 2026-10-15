import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionId } from "../../lib/settings";

export function SettingsNavigation({ active, onSelect, accordion = false }: { active: SettingsSectionId; onSelect(section: SettingsSectionId): void; accordion?: boolean }) {
  return <nav aria-label="Secciones de configuración" className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-1">
    {SETTINGS_GROUPS.map(group => {
      const items = <div className="grid gap-1">
        {SETTINGS_SECTIONS.filter(section => section.group === group).map(section => <button key={section.id} type="button"
          aria-current={active === section.id ? "page" : undefined} onClick={() => onSelect(section.id)}
          className={`w-full min-w-0 rounded-xl border px-3 py-3 text-left transition ${active === section.id ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-100" : "border-transparent text-slate-300 hover:bg-slate-900"}`}>
          <span className="block text-sm font-semibold">{section.label}</span>
          <span className="mt-1 block text-xs opacity-70">{section.hint}</span>
        </button>)}
      </div>;
      return accordion ? <details key={group} open={SETTINGS_SECTIONS.find(section => section.id === active)?.group === group} className="rounded-xl border border-slate-700 p-3">
        <summary className="cursor-pointer py-2 font-semibold text-slate-100">{group}</summary>{items}
      </details> : <section key={group} className="min-w-0"><h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{group}</h2>{items}</section>;
    })}
  </nav>;
}

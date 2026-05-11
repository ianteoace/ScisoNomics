export function SectionHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 className="section-title">{title}</h3>
        {subtitle ? <p className="section-subtitle mt-1">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

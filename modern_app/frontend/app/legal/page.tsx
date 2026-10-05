import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";

// Read the installer's single legal source at build time, including in static export.
// Nothing fetches a desktop API or rewrites the legal wording on the client.
const source = readFileSync(join(process.cwd(), "src-tauri", "LICENSE.txt"), "utf8");
const terms = source.indexOf("SECCIÓN I —");
const privacy = source.indexOf("SECCIÓN II —");
const acceptance = source.indexOf("SECCIÓN III —");
if (terms < 0 || privacy <= terms || acceptance <= privacy) throw new Error("Legal document sections are missing.");
const sections = [
  { id: "introduccion", text: source.slice(0, terms) },
  { id: "terminos", text: source.slice(terms, privacy) },
  { id: "privacidad", text: source.slice(privacy, acceptance) },
  { id: "aceptacion", text: source.slice(acceptance) },
];

export default function LegalPage() {
  return <article className="mx-auto w-full min-w-0 max-w-2xl space-y-4 p-4" aria-label="Documento legal de ScisoNomics">
    <Link className="btn-secondary inline-flex min-h-12 items-center" href="/configuracion" prefetch={false}>Volver a Configuración</Link>
    {sections.map(({ id, text }) => <pre key={id} id={id} className="scroll-mt-24 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-300">{text}</pre>)}
  </article>;
}

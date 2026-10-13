"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { SettingsNavigation } from "../../layout/SettingsNavigation";
import { SETTINGS_SECTIONS, settingsSectionFromUrl, type SettingsSectionId } from "../../../lib/settings";
import { useMobileAccount } from "../account/MobileAccountProvider";
import { MobileCloudPull } from "../account/MobileCloudPull";
import { AccountDevices } from "../../account/AccountDevices";
import { MobileDialog } from "../MobileDialog";
import packageJson from "../../../package.json";
import { mobileSections } from "../MobileSidebar";
import { MobileAccount } from "../account/MobileAccount";
import { MobilePremium } from "../billing/MobilePremium";
import { MobileQuickEntrySettings } from "./MobileQuickEntrySettings";

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card min-w-0 space-y-3 p-4">
    <h2 className="text-lg font-semibold">{title}</h2>
    <div className="space-y-3 break-words text-sm text-slate-300">{children}</div>
  </section>;
}

export function MobileSettings() {
  const [active, setActive] = useState<SettingsSectionId>("general");
  const [guides, setGuides] = useState(false);
  const { financialContext, financialAccount, session } = useMobileAccount();
  useEffect(() => {
    const readRoute = () => setActive(settingsSectionFromUrl(window.location.search));
    const account = () => setActive("cuenta");
    readRoute();
    if (window.sessionStorage.getItem("scisonomics_open_account_panel") === "1") {
      account(); window.sessionStorage.removeItem("scisonomics_open_account_panel");
    }
    window.addEventListener("popstate", readRoute);
    window.addEventListener("scisonomics:open-account-panel", account);
    return () => { window.removeEventListener("popstate", readRoute); window.removeEventListener("scisonomics:open-account-panel", account); };
  }, []);
  function select(section: SettingsSectionId) {
    setActive(section);
    const url = new URL(window.location.href); url.searchParams.set("section", section); url.searchParams.delete("panel");
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  const section = SETTINGS_SECTIONS.find(item => item.id === active)!;
  function content() {
    switch (active) {
      case "cuenta": return <MobileAccount showSync={false} showDevices={false} />;
      case "sync": return financialAccount ? <MobileCloudPull key={financialContext.ownerId} ownerId={financialContext.ownerId} isCurrent={financialContext.isCurrent} /> : <p>Iniciá sesión en Cuenta para descargar o enviar cambios. Tus datos locales siguen disponibles.</p>;
      case "dispositivos": return session ? <AccountDevices key={session.user.id} ownerId={session.user.id} /> : <p>Iniciá sesión y autorizá este dispositivo para administrar la seguridad de tu cuenta.</p>;
      case "datos": return <><p>Tus datos se guardan en este dispositivo y se mantienen separados por cuenta.</p><p>Backups y restauración estarán disponibles próximamente en Mobile. Desinstalar la app o borrar su almacenamiento elimina los datos locales.</p></>;
      case "diagnostico": return <><p>El almacenamiento local se verifica al abrir la aplicación.</p><p>La revisión manual de integridad, reparación y protección local avanzada todavía no están disponibles en Mobile.</p></>;
      case "suscripcion": return <><MobilePremium /><ul className="list-disc space-y-2 pl-5">{mobileSections.filter(item => item.premium).map(item => <li key={item.feature}>{item.label}</li>)}</ul></>;
      case "actualizaciones": return <><p>Las actualizaciones de Android se gestionan mediante Google Play cuando instalás la app desde la tienda.</p><p>No se utiliza el actualizador de Desktop.</p></>;
      case "acerca": return <><p className="font-semibold text-cyan-200">ScisoNomics · Versión {packageJson.version}</p><p>Tus finanzas personales, organizadas en tu dispositivo.</p><h3 className="font-semibold">Novedades</h3><ul className="list-disc space-y-2 pl-5"><li>Tu saldo se mantiene correctamente al comenzar un nuevo mes.</li><li>Registrá movimientos y organizá categorías, presupuestos y metas.</li><li>Consultá estadísticas y reportes sin conexión.</li></ul><h3 className="font-semibold">Legal y soporte</h3><div className="grid gap-2"><Link className="btn-secondary min-h-12 p-3" href="/legal#terminos" prefetch={false}>Términos de uso</Link><Link className="btn-secondary min-h-12 p-3" href="/legal#privacidad" prefetch={false}>Política de privacidad</Link><Link className="btn-secondary min-h-12 p-3" href="/legal#aceptacion" prefetch={false}>Aceptación y licencia</Link></div><p className="select-text break-all font-semibold">scisoftwareco@gmail.com</p><p>Mantené presionado el email para seleccionarlo y copiarlo.</p></>;
      default: return <><p>Tema oscuro para todas las pantallas.</p><p>Tu saldo se calcula con los movimientos registrados y conserva el saldo del mes anterior.</p><button className="btn-secondary min-h-12" onClick={() => setGuides(true)}>Volver a mostrar guías</button><MobileQuickEntrySettings /></>;
    }
  }
  return <div className="grid min-w-0 gap-4" aria-label="Configuración local">
    <SettingsNavigation active={active} onSelect={select} accordion />
    <SettingsCard title={section.label}>{content()}</SettingsCard>
    {guides ? <MobileDialog title="Guía de ScisoNomics" onClose={() => setGuides(false)}><div className="grid gap-3 text-sm"><p>Inicio muestra el resumen del período seleccionado.</p><p>En Movimientos registrás ingresos, gastos, ahorros e inversiones. En Categorías organizás tus registros.</p><p>Desde el menú lateral podés iniciar sesión o cambiar de cuenta. Datos locales y datos de cada cuenta permanecen separados.</p><p>En Cuenta y nube elegís cuándo descargar y enviar tus cambios.</p></div></MobileDialog> : null}
  </div>;
}

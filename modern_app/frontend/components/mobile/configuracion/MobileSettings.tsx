"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { prepareSettingsHistory, navigateSettingsHistory } from "../../../lib/mobileSettingsHistory";
import { MobileSettingsNavigation, MOBILE_SETTINGS_GROUPS, mobileSettingsFromUrl, type MobileSettingsId } from "./MobileSettingsNavigation";
import { getRuntimePlatformSync } from "../../../services/platform";
import { getCachedEntitlements, ENTITLEMENTS_CHANGED_EVENT } from "../../../services/entitlements";
import { getMobilePullCursor } from "../../../services/data/mobileCloudPull";
import { getMobileCloudPending } from "../../../services/data/mobileCloudPush";
import { isMobileRecoveryBlocked, MOBILE_RECOVERY_CHANGED } from "../../../services/mobileRecoveryState";
import { OPEN_MOBILE_RECOVERY_EVENT } from "../account/MobileAccountRecovery";
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
  const [active, setActive] = useState<MobileSettingsId | null>(() => typeof window === "undefined" ? null
    : mobileSettingsFromUrl(window.location.search, getRuntimePlatformSync() === "android"));
  const [guides, setGuides] = useState(false);
  const { financialContext, financialAccount, session, checking, error } = useMobileAccount();
  const android = getRuntimePlatformSync() === "android";
  const [revision, setRevision] = useState(0);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [syncSummary, setSyncSummary] = useState<{ owner: string; text: string } | null>(null);
  const owner = financialContext.ownerId;
  const recoveryPending = isMobileRecoveryBlocked();
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    const connection = () => setOnline(navigator.onLine !== false);
    window.addEventListener(ENTITLEMENTS_CHANGED_EVENT, changed);
    window.addEventListener(MOBILE_RECOVERY_CHANGED, changed);
    window.addEventListener("online", connection); window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener(ENTITLEMENTS_CHANGED_EVENT, changed);
      window.removeEventListener(MOBILE_RECOVERY_CHANGED, changed);
      window.removeEventListener("online", connection); window.removeEventListener("offline", connection);
    };
  }, []);
  useEffect(() => {
    // Read only local metadata on entry/return. Never start a cloud operation here.
    if (active !== null || !financialAccount) return;
    let current = true;
    void Promise.all([getMobilePullCursor(owner), getMobileCloudPending(owner)]).then(([cursor, pending]) => {
      const rows = [...pending.categorias, ...pending.movimientos];
      const text = rows.some(row => row.sync_error_code) ? "Requiere atención" : rows.length ? "Pendiente"
        : cursor ? "Sin pendientes locales" : "Sincronización manual";
      if (current && financialContext.isCurrent()) setSyncSummary({ owner, text });
    }).catch(() => { if (current && financialContext.isCurrent()) setSyncSummary({ owner, text: "Requiere atención" }); });
    return () => { current = false; };
  }, [active, financialAccount, owner, financialContext.isCurrent, revision]);
  useEffect(() => {
    const readRoute = () => setActive(mobileSettingsFromUrl(window.location.search, android));
    const account = () => { navigateSettingsHistory("cuenta", android); setActive("cuenta"); };
    prepareSettingsHistory(mobileSettingsFromUrl(window.location.search, android), android);
    readRoute();
    if (window.sessionStorage.getItem("scisonomics_open_account_panel") === "1") {
      account(); window.sessionStorage.removeItem("scisonomics_open_account_panel");
    }
    window.addEventListener("popstate", readRoute);
    window.addEventListener("scisonomics:open-account-panel", account);
    return () => { window.removeEventListener("popstate", readRoute); window.removeEventListener("scisonomics:open-account-panel", account); };
  }, [android]);
  function select(section: MobileSettingsId | null) {
    setActive(section);
    navigateSettingsHistory(section, android);
  }
  const section = MOBILE_SETTINGS_GROUPS.flatMap(group => group.rows).find(item => item.id === active);
  const summaries = {
    cuenta: checking ? "Comprobando cuenta" : error ? "Requiere atención" : session ? "Sesión iniciada" : financialAccount ? "Cuenta guardada" : "Modo local",
    sync: !online ? "Sin conexión" : recoveryPending || error ? "Requiere atención" : !financialAccount ? "Iniciá sesión para sincronizar" : syncSummary?.owner === owner ? syncSummary.text : "Consultando estado local",
    recovery: recoveryPending ? "Revisá los datos de la sesión anterior" : "Revisar datos anteriores",
    suscripcion: getCachedEntitlements(owner).plan === "premium" ? "Activo" : "No activo",
    acerca: `Versión ${packageJson.version}`,
  };
  function content() {
    switch (active) {
      case "quick-entry": return android ? <MobileQuickEntrySettings showTitle={false} /> : null;
      case "recovery": return <><p>{recoveryPending ? "Hay datos de una sesión anterior pendientes de revisión. La sincronización permanece pausada hasta revisarlos." : "Podés revisar los datos guardados de una sesión anterior. No se transfieren sin tu confirmación."}</p><button type="button" className="btn-secondary min-h-11 w-full" onClick={() => window.dispatchEvent(new Event(OPEN_MOBILE_RECOVERY_EVENT))}>Revisar datos anteriores</button>{!session ? <button type="button" className="btn-secondary min-h-11 w-full" onClick={() => select("cuenta")}>Abrir Cuenta</button> : null}</>;
      case "cuenta": return <MobileAccount showSync={false} showDevices={false} />;
      case "sync": return financialAccount ? <MobileCloudPull key={financialContext.ownerId} ownerId={financialContext.ownerId} isCurrent={financialContext.isCurrent} /> : <p>Iniciá sesión en Cuenta para descargar o enviar cambios. Tus datos locales siguen disponibles.</p>;
      case "dispositivos": return session ? <AccountDevices key={session.user.id} ownerId={session.user.id} /> : <p>Iniciá sesión y autorizá este dispositivo para administrar la seguridad de tu cuenta.</p>;
      case "datos": return <><p>Tus datos se guardan en este dispositivo y se mantienen separados por cuenta.</p><p>Backups y restauración estarán disponibles próximamente en Mobile. Desinstalar la app o borrar su almacenamiento elimina los datos locales.</p></>;
      case "diagnostico": return <><p>El almacenamiento local se verifica al abrir la aplicación.</p><p>La revisión manual de integridad, reparación y protección local avanzada todavía no están disponibles en Mobile.</p></>;
      case "suscripcion": return <><MobilePremium /><ul className="list-disc space-y-2 pl-5">{mobileSections.filter(item => item.premium).map(item => <li key={item.feature}>{item.label}</li>)}</ul></>;
      case "actualizaciones": return <><p>Las actualizaciones de Android se gestionan mediante Google Play cuando instalás la app desde la tienda.</p><p>No se utiliza el actualizador de Desktop.</p></>;
      case "acerca": return <><p className="font-semibold text-cyan-200">ScisoNomics · Versión {packageJson.version}</p><p>Tus finanzas personales, organizadas en tu dispositivo.</p><h3 className="font-semibold">Novedades</h3><ul className="list-disc space-y-2 pl-5"><li>Tu saldo se mantiene correctamente al comenzar un nuevo mes.</li><li>Registrá movimientos y organizá categorías, presupuestos y metas.</li><li>Consultá estadísticas y reportes sin conexión.</li></ul></>;
      case "legal": return <><h3 className="font-semibold">Legal y soporte</h3><div className="grid gap-2"><Link className="btn-secondary min-h-12 p-3" href="/legal#terminos" prefetch={false}>Términos de uso</Link><Link className="btn-secondary min-h-12 p-3" href="/legal#privacidad" prefetch={false}>Política de privacidad</Link><Link className="btn-secondary min-h-12 p-3" href="/legal#aceptacion" prefetch={false}>Aceptación y licencia</Link></div><p className="select-text break-all font-semibold">scisoftwareco@gmail.com</p><p>Mantené presionado el email para seleccionarlo y copiarlo.</p></>;
      default: return <><p>Tema oscuro para todas las pantallas.</p><p>Tu saldo se calcula con los movimientos registrados y conserva el saldo del mes anterior.</p><button className="btn-secondary min-h-12" onClick={() => setGuides(true)}>Volver a mostrar guías</button></>;
    }
  }
  return <div className="grid min-w-0 gap-4" aria-label="Configuración local">
    {section ? <>
      <div className="sticky top-[calc(4rem+env(safe-area-inset-top,0px))] z-10 -mx-1 bg-slate-950/95 px-1 py-2">
        <button type="button" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400" onClick={() => select(null)}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />Volver a Configuración
        </button>
      </div>
      <SettingsCard title={section.title}>{content()}</SettingsCard>
    </> : <MobileSettingsNavigation android={android} summaries={summaries} recoveryPending={recoveryPending} onSelect={select} />}
    {guides ? <MobileDialog title="Guía de ScisoNomics" onClose={() => setGuides(false)}><div className="grid gap-3 text-sm"><p>Inicio muestra el resumen del período seleccionado.</p><p>En Movimientos registrás ingresos, gastos, ahorros e inversiones. En Categorías organizás tus registros.</p><p>Desde el menú lateral podés iniciar sesión o cambiar de cuenta. Datos locales y datos de cada cuenta permanecen separados.</p><p>En Cuenta y nube elegís cuándo descargar y enviar tus cambios.</p></div></MobileDialog> : null}
  </div>;
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import packageJson from "../../../package.json";
import { mobileSections } from "../MobileSidebar";
import { MobileAccount } from "../account/MobileAccount";

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card min-w-0 space-y-3 p-4">
    <h2 className="text-lg font-semibold">{title}</h2>
    <div className="space-y-3 break-words text-sm text-slate-300">{children}</div>
  </section>;
}

export function MobileSettings() {
  return <div className="grid min-w-0 gap-4" aria-label="Configuración local">
    <SettingsCard title="Finanzas">
      <p>Tu saldo se calcula con los movimientos registrados. El saldo del mes anterior se mantiene al comenzar un nuevo mes.</p>
      <p>Para actualizarlo, registrá o corregí tus movimientos.</p>
      <Link className="btn-secondary flex min-h-12 items-center justify-center" href="/movimientos" prefetch={false}>Ver movimientos</Link>
    </SettingsCard>
    <SettingsCard title="Apariencia"><p>Tema oscuro para todas las pantallas.</p></SettingsCard>
    <SettingsCard title="Cuenta"><MobileAccount /></SettingsCard>
    <SettingsCard title="Sincronización"><p>Desde Cuenta podés descargar categorías y movimientos con “Sincronizar ahora” y enviar pendientes con “Subir cambios”.</p><p>Creá movimientos para tu cuenta desde esa sección. Tus finanzas locales permanecen separadas.</p></SettingsCard>
    <SettingsCard title="ScisoNomics Premium">
      <p>Durante el desarrollo Mobile, estas funciones están habilitadas:</p>
      <ul className="list-disc space-y-2 pl-5">{mobileSections.filter((section) => section.premium).map((section) => <li key={section.feature}>{section.label}</li>)}</ul>
      <p>La contratación de Premium todavía no está habilitada en Mobile.</p>
    </SettingsCard>
    <SettingsCard title="Backups y restauración"><p>Disponible próximamente en Mobile.</p><p>Todavía no se crean copias de seguridad. Desinstalar la app o borrar su almacenamiento elimina los datos locales.</p></SettingsCard>
    <SettingsCard title="Actualizaciones"><p>Las actualizaciones de Android se gestionarán mediante la tienda.</p><p>Esta función todavía no está habilitada.</p></SettingsCard>
    <SettingsCard title="Acerca de ScisoNomics">
      <p className="font-semibold text-cyan-200">ScisoNomics · Versión {packageJson.version}</p>
      <p>Tus finanzas personales, organizadas en tu dispositivo.</p>
      <p>Tu saldo se mantiene correctamente al comenzar un nuevo mes.</p>
      <p>Registrá movimientos y organizá categorías, presupuestos y metas. Consultá tus estadísticas y reportes sin conexión.</p>
    </SettingsCard>
    <SettingsCard title="Legal">
      <p>Consultá el documento vigente de ScisoNomics.</p>
      <div className="grid gap-2">
        <Link className="btn-secondary flex min-h-12 items-center justify-center" href="/legal#terminos" prefetch={false}>Términos de uso</Link>
        <Link className="btn-secondary flex min-h-12 items-center justify-center" href="/legal#privacidad" prefetch={false}>Política de privacidad</Link>
        <Link className="btn-secondary flex min-h-12 items-center justify-center" href="/legal#aceptacion" prefetch={false}>Aceptación y licencia</Link>
      </div>
    </SettingsCard>
    <SettingsCard title="Soporte">
      <p>Escribinos a:</p>
      <p className="select-text break-all font-semibold text-cyan-200">scisoftwareco@gmail.com</p>
      <p>Mantené presionado el email para seleccionarlo y copiarlo.</p>
    </SettingsCard>
  </div>;
}

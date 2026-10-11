export const SETTINGS_GROUPS = ["Cuenta y nube", "Datos y seguridad", "Suscripción", "Aplicación"] as const;
export const SETTINGS_SECTIONS = [
  { id: "cuenta", label: "Cuenta", hint: "Inicio de sesión y multicuentas", group: "Cuenta y nube" },
  { id: "sync", label: "Sincronización", hint: "Descarga y envío de cambios", group: "Cuenta y nube" },
  { id: "datos", label: "Datos y backups", hint: "Datos locales y restauración", group: "Datos y seguridad" },
  { id: "diagnostico", label: "Integridad y protección", hint: "Revisión y seguridad local", group: "Datos y seguridad" },
  { id: "dispositivos", label: "Dispositivos confiables", hint: "Seguridad de tu cuenta", group: "Datos y seguridad" },
  { id: "suscripcion", label: "ScisoNomics Premium", hint: "Estado y gestión de suscripción", group: "Suscripción" },
  { id: "general", label: "General", hint: "Estado y guías de la aplicación", group: "Aplicación" },
  { id: "actualizaciones", label: "Actualizaciones", hint: "Actualización según plataforma", group: "Aplicación" },
  { id: "acerca", label: "Acerca de", hint: "Versión, novedades y soporte", group: "Aplicación" },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export function isSettingsSection(value: string | null): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some(section => section.id === value);
}
export function settingsSectionFromUrl(search: string): SettingsSectionId {
  const params = new URLSearchParams(search);
  if (params.get("panel") === "cuenta") return "cuenta";
  const value = params.get("section");
  return isSettingsSection(value) ? value : "general";
}

"use client";

import { useEffect, useState } from "react";

import { ErrorState } from "../../../components/ui/ErrorState";
import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import { createSecurityCopyWithSaveDialog } from "../../../services/backupDownload";
import type { SettingsInfo } from "../../../types/domain";

const ONBOARDING_REOPEN_EVENT = "scisonomics:open-onboarding-guides";
const ONBOARDING_SECTION_KEYS = [
  "scisonomics_onboarding_inicio_seen",
  "scisonomics_onboarding_movimientos_seen",
  "scisonomics_onboarding_presupuestos_seen",
  "scisonomics_onboarding_metas_seen",
  "scisonomics_onboarding_gastos_fijos_seen",
  "scisonomics_onboarding_planificacion_seen",
  "scisonomics_onboarding_calendario_seen",
  "scisonomics_onboarding_estadisticas_seen",
  "scisonomics_onboarding_reporte_mensual_seen",
  "scisonomics_onboarding_configuracion_seen",
] as const;

export default function ConfiguracionPage() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const { showError, showSuccess } = useToast();

  async function load() {
    setLoading(true);
    try {
      setInfo(await api.settingsInfo());
      setLoadError("");
    } catch (e: any) {
      setLoadError(e?.message || "No se pudo cargar la configuración.");
      showError(e?.message || "No se pudo cargar la configuración.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreateSecurityCopy() {
    try {
      await createSecurityCopyWithSaveDialog();
      showSuccess("Copia de seguridad creada correctamente.");
    } catch (error) {
      console.error("Error creando copia de seguridad:", error);
      showError(error instanceof Error ? error.message : "No se pudo crear la copia de seguridad.");
    }
  }

  async function handlePickRestoreFile() {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!isTauri) {
        showError("La restauración de copia de seguridad está disponible solo en la app de escritorio.");
        return;
      }

      const [{ open }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
      const selected = await open({
        multiple: false,
        filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
      });
      if (!selected) return;

      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path || !path.toLowerCase().endsWith(".db")) {
        showError("Debes seleccionar un archivo .db valido.");
        return;
      }
      setSelectedRestorePath(path);
    } catch (error) {
      console.error("Error seleccionando copia de seguridad:", error);
      showError("No se pudo seleccionar la copia de seguridad.");
    }
  }

  async function handleConfirmRestore() {
    if (!selectedRestorePath || restoring) return;
    setRestoring(true);
    try {
      await api.restoreBackupFromPath(selectedRestorePath);
      setSelectedRestorePath(null);
      showSuccess("Copia restaurada correctamente. Reinicia ScisoNomics para aplicar los cambios.");
    } catch (error: any) {
      console.error("Error restaurando copia de seguridad:", error);
      const message = typeof error?.message === "string" ? error.message : "";
      const normalized = message.toLowerCase();
      if (
        normalized.includes("sqlite") ||
        normalized.includes("estructura minima") ||
        normalized.includes("archivo .db") ||
        normalized.includes("vacia") ||
        normalized.includes("no existe") ||
        normalized.includes("no es un archivo")
      ) {
        showError("No se pudo restaurar la copia de seguridad. Verificá que el archivo sea una copia válida de ScisoNomics.");
      } else if (normalized.includes("base de datos esta en uso")) {
        showError("No se pudo restaurar porque tus datos están en uso. Cerrá y volvé a abrir ScisoNomics.");
      } else {
        showError("No se pudo restaurar la copia de seguridad. Intentá nuevamente o elegí otra copia.");
      }
    } finally {
      setRestoring(false);
    }
  }

  const selectedRestoreName = selectedRestorePath ? selectedRestorePath.split(/[/\\]/).pop() || selectedRestorePath : null;

  function handleReopenOnboarding() {
    if (typeof window === "undefined") return;
    try {
      for (const key of ONBOARDING_SECTION_KEYS) window.localStorage.removeItem(key);
    } catch {
      // La guia no debe bloquear la app si localStorage falla.
    }
    window.dispatchEvent(new Event(ONBOARDING_REOPEN_EVENT));
  }

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <h2 className="text-2xl font-bold">Configuración</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Gestioná tu información y conservá tus datos de forma segura.
        </p>
      </header>

      {loading ? <LoadingSkeleton rows={5} /> : null}
      {loadError ? <ErrorState title="No se pudieron cargar los datos de configuración." description={loadError} onRetry={load} /> : null}

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Datos y copias de seguridad</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Crear copia de seguridad guarda una copia de tus datos actuales.
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Restaurar copia de seguridad reemplaza tus datos actuales por una copia guardada.
        </p>
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          Recomendamos no cambiar el nombre ni la extensión del archivo de copia de seguridad. Si lo renombrás, conservá la extensión .db.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button className="btn" onClick={handleCreateSecurityCopy}>Crear copia de seguridad</button>
          <button className="btn-secondary" onClick={handlePickRestoreFile}>Restaurar copia de seguridad</button>
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Acerca de ScisoNomics</h3>
        <div className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-300">
          <p><strong>ScisoNomics</strong></p>
          <p>Versión 1.8.0</p>
          <p>Aplicación desktop para gestión de finanzas personales.</p>
          <p>Tus datos se guardan localmente en tu equipo.</p>
          <p className="text-slate-500 dark:text-slate-400">Next.js - Tauri - FastAPI - SQLite</p>
          {info?.db_exists === false ? <p className="text-amber-600 dark:text-amber-400">Tus datos locales todavía se están preparando.</p> : null}
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Guias de uso</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Mostrá nuevamente las explicaciones breves de cada sección.
        </p>
        <div className="mt-4">
          <button className="btn-secondary" onClick={handleReopenOnboarding}>Volver a ver guías</button>
        </div>
      </section>

      <Modal open={!!selectedRestorePath} title="Restaurar copia de seguridad" onClose={() => setSelectedRestorePath(null)}>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Esta acción reemplazará tus datos actuales por los datos de la copia seleccionada.
        </p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Antes de restaurar, ScisoNomics creará automáticamente una copia de seguridad de tus datos actuales.
        </p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Luego deberás reiniciar la aplicación para ver los cambios.
        </p>
        {selectedRestoreName ? (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            Archivo seleccionado: {selectedRestoreName}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setSelectedRestorePath(null)} disabled={restoring}>
            Cancelar
          </button>
          <button className="btn" onClick={handleConfirmRestore} disabled={restoring}>
            {restoring ? "Restaurando..." : "Restaurar copia"}
          </button>
        </div>
      </Modal>
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { LoadingSkeleton } from "../../../components/ui/LoadingSkeleton";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { SettingsInfo } from "../../../types/domain";

export default function ConfiguracionPage() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [selectedRestorePath, setSelectedRestorePath] = useState<string | null>(null);
  const { showError, showSuccess } = useToast();

  async function load() {
    setLoading(true);
    try {
      setInfo(await api.settingsInfo());
    } catch (e: any) {
      showError(e?.message || "No se pudo cargar la configuracion.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreateSecurityCopy() {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      const datePart = getDatePart();
      const suggestedName = `ScisoNomics_copia_seguridad_${datePart}.db`;

      if (isTauri) {
        const [{ save }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
        const selectedPath = await save({
          defaultPath: suggestedName,
          filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
        });
        if (!selectedPath) return;

        const { blob } = await api.downloadBackup();
        const targetPath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await invoke("save_binary_file", { path: targetPath, bytes: Array.from(bytes) });
        showSuccess("Copia de seguridad creada correctamente.");
        return;
      }

      const { blob } = await api.downloadBackup();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      showSuccess("Copia de seguridad creada correctamente.");
    } catch (error) {
      console.error("Error creando copia de seguridad:", error);
      showError("No se pudo crear la copia de seguridad.");
    }
  }

  async function handlePickRestoreFile() {
    try {
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (!isTauri) {
        showError("La restauracion de copia de seguridad esta disponible solo en la app de escritorio.");
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
      showSuccess("Copia restaurada correctamente. Reiniciá ScisoNomics para aplicar los cambios.");
    } catch (error) {
      console.error("Error restaurando copia de seguridad:", error);
      showError("No se pudo restaurar la copia de seguridad.");
    } finally {
      setRestoring(false);
    }
  }

  function getDatePart() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return (
    <section className="space-y-4">
      <header className="card p-5">
        <h2 className="text-2xl font-bold">Configuracion</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Gestiona tu informacion y conserva tus datos de forma segura.
        </p>
      </header>

      {loading ? <LoadingSkeleton rows={5} /> : null}

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Datos y copias de seguridad</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Crear copia de seguridad guarda una copia de tus datos actuales.
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Restaurar copia de seguridad reemplaza tus datos actuales por una copia guardada.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn" onClick={handleCreateSecurityCopy}>Crear copia de seguridad</button>
          <button className="btn-secondary" onClick={handlePickRestoreFile}>Restaurar copia de seguridad</button>
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Acerca de ScisoNomics</h3>
        <div className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-300">
          <p><strong>ScisoNomics</strong></p>
          <p>Version 1.5.0</p>
          <p>Aplicacion desktop para gestion de finanzas personales.</p>
          <p>Tus datos se guardan localmente en tu equipo.</p>
          <p className="text-slate-500 dark:text-slate-400">Next.js · Tauri · FastAPI · SQLite</p>
          {info?.db_exists === false ? <p className="text-amber-600 dark:text-amber-400">Aun no se encontro la base de datos local.</p> : null}
        </div>
      </section>

      {selectedRestorePath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <h4 className="text-lg font-semibold">Restaurar copia de seguridad</h4>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              Esta accion reemplazara tus datos actuales por los datos de la copia seleccionada.
            </p>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Antes de restaurar, ScisoNomics creara automaticamente una copia de seguridad de tus datos actuales.
            </p>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Luego deberas reiniciar la aplicacion para ver los cambios.
            </p>
            <p className="mt-3 break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              Archivo seleccionado: {selectedRestorePath}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setSelectedRestorePath(null)} disabled={restoring}>
                Cancelar
              </button>
              <button className="btn" onClick={handleConfirmRestore} disabled={restoring}>
                {restoring ? "Restaurando..." : "Restaurar copia"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

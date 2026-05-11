"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { BackupState, SettingsInfo } from "../../../types/domain";

export default function ConfiguracionPage() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [backendStatus, setBackendStatus] = useState<"ok" | "error" | "idle">("idle");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [backups, setBackups] = useState<BackupState | null>(null);
  const { showError, showSuccess } = useToast();

  async function load() {
    try {
      setInfo(await api.settingsInfo());
      setBackups(await api.backups());
      setBackendStatus("ok");
    } catch (e: any) {
      setBackendStatus("error");
      showError(e.message || "No se pudo cargar configuración");
    }
  }

  useEffect(() => { load(); }, []);

  async function testBackend() {
    try {
      await api.settingsInfo();
      setBackendStatus("ok");
      showSuccess("Backend conectado");
    } catch (e: any) {
      setBackendStatus("error");
      showError(e.message || "Backend no responde");
    }
  }

  function openPath(path: string) {
    window.open(`file:///${path.replace(/\\/g, "/")}`);
  }

  async function exportBackup() {
    await api.createBackup();
    setBackups(await api.backups());
    showSuccess("Backup creado");
  }

  async function onRestore(fileName?: string) {
    if (!fileName) return;
    if (!confirm("Se restaurará el backup seleccionado y se creará una copia de seguridad previa. ¿Continuar?")) return;
    try {
      await api.restoreBackup(fileName);
      showSuccess("Backup restaurado correctamente");
      await load();
    } catch (e: any) {
      showError(e.message || "No se pudo restaurar el backup");
    }
  }

  return (
    <section className="card p-5 space-y-4">
      <h2 className="text-xl font-bold">Configuración</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <p className="text-sm text-slate-400">Versión app</p>
          <p className="font-semibold">{info?.version || "0.2.0"}</p>
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="text-sm text-slate-400">Estado backend</p>
          <p className={`font-semibold ${backendStatus === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{backendStatus === "ok" ? "Conectado" : "Sin conexión"}</p>
          <button className="btn mt-2" onClick={testBackend}>Probar conexión</button>
        </div>
      </div>
      <div className="rounded-xl border border-line p-3">
        <p className="text-sm text-slate-400">Ruta base de datos</p>
        <p className="text-sm break-all">{info?.db_path}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => info && openPath(info.data_dir)}>Abrir carpeta de datos</button>
        <button className="btn-secondary" onClick={exportBackup}>Exportar backup</button>
        <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>Restaurar backup</button>
        {info?.logs_exists ? <button className="btn-secondary" onClick={() => openPath(info.logs_dir)}>Abrir carpeta de logs</button> : null}
      </div>
      <div className="rounded-xl border border-line p-3 space-y-2">
        <p className="text-sm text-slate-400">Carpeta backups: {backups?.folder}</p>
        <p className="text-sm text-slate-400">Cantidad: {backups?.count || 0}</p>
        <select className="input" value={backups?.frequency || "desactivado"} onChange={async (e) => { await api.setBackupFrequency(e.target.value); setBackups(await api.backups()); }}>
          <option value="desactivado">Desactivado</option>
          <option value="diario">Diario</option>
          <option value="semanal">Semanal</option>
          <option value="mensual">Mensual</option>
        </select>
        {(backups?.items || []).slice(0, 10).map((b) => (
          <div key={b.name} className="flex items-center justify-between rounded-lg border border-line p-2 text-xs">
            <span>{b.name}</span>
            <button className="btn-secondary" onClick={() => onRestore(b.name)}>Restaurar</button>
          </div>
        ))}
      </div>
      <input ref={fileInputRef} className="hidden" type="file" accept=".db" onChange={() => undefined} />
    </section>
  );
}

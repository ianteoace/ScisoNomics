import { API_URL, getJSON, getLocalRequestHeaders, sendJSON } from "./http";
import { notifyDataChanged } from "./cloudSync";
import { getLocalDateInputValue } from "../lib/date";
import type { AnnualStatsResponse, BackupState, Categoria, GastoFijo, GastoProgramado, MetaAhorro, MovimientosResponse, Presupuesto, SettingsInfo, StatsResponse, Tag } from "../types/domain";

async function syncMutation<T>(operation: Promise<T>): Promise<T> {
  const result = await operation;
  notifyDataChanged();
  return result;
}

export const api = {
  movimientos: (month: number, year: number, tipo: string, search: string, categoria = "", minMonto?: number, maxMonto?: number) =>
    getJSON<MovimientosResponse>(`/movimientos?month=${month}&year=${year}&tipo=${tipo}&search=${encodeURIComponent(search)}&categoria=${encodeURIComponent(categoria)}${minMonto !== undefined ? `&min_monto=${minMonto}` : ""}${maxMonto !== undefined ? `&max_monto=${maxMonto}` : ""}`),
  createMovimiento: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/movimientos", "POST", payload)),
  updateMovimiento: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/movimientos/${id}`, "PUT", payload)),
  deleteMovimiento: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/movimientos/${id}`, "DELETE")),

  categorias: (tipo: "todos" | "ingreso" | "gasto" | "ahorro" | "inversion" = "todos") => getJSON<Categoria[]>(`/categorias?tipo=${tipo}`),
  createCategoria: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/categorias", "POST", payload)),
  updateCategoria: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/categorias/${id}`, "PUT", payload)),
  deleteCategoria: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/categorias/${id}`, "DELETE")),

  gastosFijos: () => getJSON<GastoFijo[]>("/gastos-fijos"),
  createGastoFijo: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/gastos-fijos", "POST", payload)),
  updateGastoFijo: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/gastos-fijos/${id}`, "PUT", payload)),
  deleteGastoFijo: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/gastos-fijos/${id}`, "DELETE")),

  gastosProgramados: (estado = "todos", dias?: number) =>
    getJSON<GastoProgramado[]>(`/gastos-programados?estado=${estado}${dias ? `&dias=${dias}` : ""}`),
  createGastoProgramado: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/gastos-programados", "POST", payload)),
  updateGastoProgramado: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/gastos-programados/${id}`, "PUT", payload)),
  deleteGastoProgramado: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/gastos-programados/${id}`, "DELETE")),
  marcarPagado: (id: number) => syncMutation(sendJSON<{ changed: boolean }>(`/gastos-programados/${id}/marcar-pagado`, "POST")),

  stats: (month: number, year: number) => getJSON<StatsResponse>(`/estadisticas?month=${month}&year=${year}`),
  statsAnual: (year: number) => getJSON<AnnualStatsResponse>(`/estadisticas/anual?year=${year}`),
  resumenMensual: (month: number, year: number) => getJSON<any>(`/resumen-mensual?month=${month}&year=${year}`),
  presupuestos: (month: number, year: number) => getJSON<Presupuesto[]>(`/presupuestos?month=${month}&year=${year}`),
  upsertPresupuesto: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/presupuestos", "POST", payload)),
  deletePresupuesto: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/presupuestos/${id}`, "DELETE")),
  settingsInfo: () => getJSON<SettingsInfo>("/settings/info"),
  backups: () => getJSON<BackupState>("/backups"),
  createBackup: () => sendJSON<{ ok: boolean; file: string; name: string }>("/backups/create", "POST"),
  restoreBackup: (file_name: string) => sendJSON<{ ok: boolean; safety_backup: string }>("/backups/restore", "POST", { file_name }),
  setBackupFrequency: (frecuencia: string) => sendJSON<{ ok: boolean }>("/backups/frequency", "POST", { frecuencia }),

  metas: () => getJSON<MetaAhorro[]>("/metas"),
  createMeta: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/metas", "POST", payload)),
  updateMeta: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/metas/${id}`, "PUT", payload)),
  deleteMeta: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/metas/${id}`, "DELETE")),

  tags: () => getJSON<Tag[]>("/tags"),
  createTag: (payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>("/tags", "POST", payload)),
  updateTag: (id: number, payload: unknown) => syncMutation(sendJSON<{ ok: boolean }>(`/tags/${id}`, "PUT", payload)),
  deleteTag: (id: number) => syncMutation(sendJSON<{ ok: boolean }>(`/tags/${id}`, "DELETE")),

  calendario: (month: number, year: number) => getJSON<any[]>(`/calendario?month=${month}&year=${year}`),
  reporteMensual: (month: number, year: number) => getJSON<any>(`/reporte-mensual?month=${month}&year=${year}`),
  exportExcel: async (month: number, year: number, desde?: string, hasta?: string) => {
    const params = new URLSearchParams();
    if (desde && hasta) {
      params.set("desde", desde);
      params.set("hasta", hasta);
    } else {
      params.set("month", String(month));
      params.set("year", String(year));
    }
    const response = await fetch(`${API_URL}/export/excel?${params.toString()}`, { method: "GET", headers: await getLocalRequestHeaders() });
    if (!response.ok) {
      const text = await response.text();
      let detail = "No se pudo exportar el Excel.";
      try {
        const parsed = JSON.parse(text);
        const message = parsed?.detail || parsed?.message;
        if (typeof message === "string" && message.trim()) detail = message.trim();
      } catch {
        if (text.trim()) detail = text.trim();
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match?.[1] || `ScisoNomics_${getLocalDateInputValue()}.xlsx`;
    return { blob, filename };
  },
  downloadBackup: async () => {
    const response = await fetch(`${API_URL}/backup/download`, { method: "GET", headers: await getLocalRequestHeaders() });
    if (!response.ok) {
      const text = await response.text();
      console.error("Backup download failed", { status: response.status });
      let detail = "No se pudo crear la copia de seguridad.";
      try {
        const parsed = JSON.parse(text);
        const message = parsed?.detail || parsed?.message;
        if (typeof message === "string" && message.trim()) detail = message.trim();
      } catch {
        if (text.trim()) detail = text.trim();
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match?.[1] || `ScisoNomics_copia_seguridad_${getLocalDateInputValue()}.db`;
    return { blob, filename };
  },
  downloadEncryptedBackup: async (passphrase: string) => {
    const response = await fetch(`${API_URL}/backup/download-encrypted`, {
      method: "POST",
      headers: await getLocalRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ passphrase }),
    });
    if (!response.ok) {
      const parsed = await response.json().catch(() => null);
      throw new Error(parsed?.detail || "No se pudo crear la copia cifrada.");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    return { blob, filename: match?.[1] || `ScisoNomics_copia_cifrada_${getLocalDateInputValue()}.sciso-backup` };
  },
  restoreBackupFromPath: async (sourcePath: string, passphrase?: string) => {
    const response = await fetch(`${API_URL}/backup/restore`, {
      method: "POST",
      headers: await getLocalRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source_path: sourcePath, ...(passphrase ? { passphrase } : {}) }),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      console.error("Restore response is not JSON", { status: response.status });
    }
    if (!response.ok) {
      console.error("Restore backup failed", { status: response.status });
      const detail = parsed?.detail || parsed?.message || text || "No se pudo restaurar la copia de seguridad.";
      throw new Error(typeof detail === "string" ? detail : "No se pudo restaurar la copia de seguridad.");
    }
    return parsed as { ok: boolean; safety_backup: string };
  },
};

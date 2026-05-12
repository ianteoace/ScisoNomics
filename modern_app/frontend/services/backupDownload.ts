"use client";

import { invoke } from "@tauri-apps/api/core";

import { getLocalDateInputValue } from "../lib/date";
import { api } from "./api";
import { API_URL } from "./http";

async function assertBackendReady() {
  try {
    const response = await fetch(`${API_URL}/health`, { cache: "no-store" });
    const text = await response.text();
    let health: any = null;
    try {
      health = JSON.parse(text);
    } catch {
      console.error("Health response is not JSON", { status: response.status, body: text });
    }

    console.info("Backup health check", { status: response.status, health });

    if (!response.ok || !health?.ok || health.db_exists === false || health.db_initialized === false) {
      throw new Error("Backend not ready");
    }
  } catch (error) {
    console.error("Backup health check failed", error);
      throw new Error("ScisoNomics todavía se está iniciando. Intentá nuevamente en unos segundos.");
  }
}

function getSafeBackupFilename() {
  return `ScisoNomics_copia_seguridad_${getLocalDateInputValue()}.db`;
}

function downloadBlobInBrowser(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function createSecurityCopyWithSaveDialog() {
  await assertBackendReady();

  const suggestedName = getSafeBackupFilename();
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (!isTauri) {
    try {
      const { blob } = await api.downloadBackup();
      if (blob.size <= 0) {
        console.error("Backup download returned an empty file");
        throw new Error("Empty backup response");
      }
      downloadBlobInBrowser(blob, suggestedName);
      return;
    } catch (error) {
      console.error("Error fetching backup from backend", error);
      throw new Error("No se pudo obtener la copia de seguridad.");
    }
  }

  const [{ save }] = await Promise.all([import("@tauri-apps/plugin-dialog")]);
  const selectedPath = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Base de datos SQLite", extensions: ["db"] }],
  });

  if (!selectedPath) return;

  const targetPath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
  console.info("Backup save path selected", { path: targetPath });

  let blob: Blob;
  try {
    const result = await api.downloadBackup();
    blob = result.blob;
    if (blob.size <= 0) {
      console.error("Backup download returned an empty file", { path: targetPath });
      throw new Error("Empty backup response");
    }
  } catch (error) {
    console.error("Error fetching backup from backend", error);
    throw new Error("No se pudo obtener la copia de seguridad.");
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await invoke("save_binary_file", { path: targetPath, bytes: Array.from(bytes) });
  } catch (error) {
    console.error("Error saving backup file", { path: targetPath, error });
    throw new Error("No se pudo guardar la copia de seguridad en la ubicación seleccionada. Probá elegir otra carpeta.");
  }
}

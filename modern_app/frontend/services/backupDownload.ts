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
      console.error("Health response is not JSON", { status: response.status });
    }

    console.info("Backup health check", { status: response.status, ok: Boolean(health?.ok) });

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

  let blob: Blob;
  try {
    const result = await api.downloadBackup();
    blob = result.blob;
    if (blob.size <= 0) {
      console.error("Backup download returned an empty file");
      throw new Error("Empty backup response");
    }
  } catch (error) {
    console.error("Error fetching backup from backend", error);
    throw new Error("No se pudo obtener la copia de seguridad.");
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await invoke<boolean>("save_binary_file", { fileName: suggestedName, extension: "db", bytes: Array.from(bytes) });
  } catch (error) {
    console.error("Error saving backup file", error);
    throw new Error("No se pudo guardar la copia de seguridad en la ubicación seleccionada. Probá elegir otra carpeta.");
  }
}

export async function createEncryptedSecurityCopyWithSaveDialog(passphrase: string) {
  await assertBackendReady();
  const { blob, filename } = await api.downloadEncryptedBackup(passphrase);
  if (blob.size <= 0) throw new Error("La copia cifrada esta vacia.");
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) {
    downloadBlobInBrowser(blob, filename);
    return;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await invoke<boolean>("save_binary_file", { fileName: filename, extension: "sciso-backup", bytes: Array.from(bytes) });
}

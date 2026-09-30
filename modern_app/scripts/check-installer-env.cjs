"use strict";

const fs = require("node:fs");
const path = require("node:path");

const frontend = path.resolve(__dirname, "../frontend");
const config = JSON.parse(fs.readFileSync(path.join(frontend, "src-tauri/tauri.conf.json"), "utf8"));
const capability = JSON.parse(fs.readFileSync(path.join(frontend, "src-tauri/capabilities/default.json"), "utf8"));
const cloudUrl = process.env.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const expectedCloudUrl = "https://scisonomics-production-d8a3.up.railway.app";
const errors = [];

if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  errors.push("Falta la clave privada o su contraseña de firma Tauri en el entorno del build.");
}

if (cloudUrl !== expectedCloudUrl) errors.push("NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL debe apuntar a Railway de producción.");
if (!publishableKey?.startsWith("sb_publishable_")) errors.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY debe ser una publishable key.");

let supabaseOrigin;
try {
  const url = new URL(supabaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid_url");
  supabaseOrigin = url.origin;
} catch {
  errors.push("NEXT_PUBLIC_SUPABASE_URL debe ser una URL HTTPS válida.");
}

if (config.bundle?.active !== true || !config.bundle?.externalBin?.includes("binaries/scisonomics-backend")) {
  errors.push("Tauri debe empaquetar el sidecar.");
}
if (config.bundle?.createUpdaterArtifacts !== true
  || !config.plugins?.updater?.pubkey
  || !config.plugins?.updater?.endpoints?.includes("https://github.com/ianteoace/scisonomics/releases/latest/download/latest.json")) {
  errors.push("Falta la configuracion de updater firmado para GitHub Releases.");
}
for (const permission of ["updater:allow-check", "updater:allow-download", "updater:allow-install"]) {
  if (!capability.permissions.includes(permission)) errors.push(`Falta el permiso ${permission}.`);
}
if (config.mainBinaryName !== "ScisoNomics") {
  errors.push("El ejecutable principal debe llamarse ScisoNomics.exe para que el instalador detecte procesos abiertos.");
}
if (!config.plugins?.["deep-link"]?.desktop?.schemes?.includes("scisonomics")) {
  errors.push("Falta el scheme scisonomics en Tauri.");
}
if (supabaseOrigin) {
  const opener = capability.permissions.find((item) => typeof item === "object" && item.identifier === "opener:allow-open-url");
  if (!config.app.security.csp.includes(supabaseOrigin)
    || !opener?.allow?.some((item) => item.url === `${supabaseOrigin}/auth/v1/authorize*`)) {
    errors.push("La URL de Supabase no coincide con CSP y el permiso de apertura de Google.");
  }
}

if (errors.length) {
  for (const error of errors) console.error(`Build de instalador bloqueado: ${error}`);
  process.exit(1);
}
console.log("Variables públicas de release, bundle y callback verificados.");

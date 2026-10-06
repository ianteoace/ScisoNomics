const isProd = process.env.NODE_ENV === "production";
const isAndroidDev = !isProd && (
  process.env.TAURI_ENV_PLATFORM === "android"
  || /-linux-android/.test(process.env.TAURI_ENV_TARGET_TRIPLE || "")
);
const internalHost = process.env.TAURI_DEV_HOST || "localhost";
// TAURI_DEV_HOST is the CLI/ADB transport host, not Android's WebView origin.
const devAssetOrigin = isAndroidDev ? "http://localhost:3000" : `http://${internalHost}:3000`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  allowedDevOrigins: [...new Set(["127.0.0.1", "localhost", "tauri.localhost", internalHost])],
  assetPrefix: isProd ? undefined : devAssetOrigin,
};

module.exports = nextConfig;


const { spawn } = require("node:child_process");
const path = require("node:path");

function desktopDevCommand(env = process.env) {
  return {
    command: process.execPath,
    args: [require.resolve("next/dist/bin/next", { paths: [path.resolve(__dirname, "../frontend")] }), "dev", "--webpack", "-p", "3001"],
    env: { ...env, SCISONOMICS_DESKTOP_CONCURRENT_DEV: "1" },
  };
}
module.exports = { desktopDevCommand };
function tauriDevCommand(env = process.env, args = []) {
  return {
    command: process.execPath,
    args: [require.resolve("@tauri-apps/cli/tauri.js", { paths: [path.resolve(__dirname, "../frontend")] }), "dev", "--config", "src-tauri/tauri.desktop.concurrent.conf.json", ...args],
    env: { ...env, SCISONOMICS_DESKTOP_CONCURRENT_DEV: "1" },
  };
}
module.exports.tauriDevCommand = tauriDevCommand;
if (require.main === module) {
  const config = process.argv[2] === "--tauri"
    ? tauriDevCommand(process.env, process.argv.slice(3)) : desktopDevCommand();
  const child = spawn(config.command, config.args, { env: config.env, stdio: "inherit" });
  child.on("error", () => { process.stderr.write("No se pudo iniciar Next desktop en 3001.\n"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

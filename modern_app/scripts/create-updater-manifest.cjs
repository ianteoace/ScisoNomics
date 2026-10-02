"use strict";

const fs = require("node:fs");
const path = require("node:path");

const frontend = path.resolve(__dirname, "../frontend");
const repo = "https://github.com/ianteoace/scisonomics";

function createManifest({ installerPath, version, tag }) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!semver || version.length > 128 || semver[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("La version no es SemVer.");
  if (tag !== `v${version}`) throw new Error("El tag debe coincidir con la version del bundle.");
  const expectedName = `ScisoNomics_${version}_x64-setup.exe`;
  if (path.basename(installerPath) !== expectedName) throw new Error(`Se esperaba ${expectedName}.`);
  if (!fs.statSync(installerPath).isFile()) throw new Error("Falta el instalador NSIS.");
  const signature = fs.readFileSync(`${installerPath}.sig`, "utf8").trim();
  if (signature.length < 80 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error("La firma .sig no tiene el formato esperado.");
  }
  return {
    version,
    platforms: {
      "windows-x86_64": {
        url: `${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(expectedName)}`,
        signature,
      },
    },
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1]) throw new Error("Uso: [--installer <ruta>] [--tag vX.Y.Z] [--output <ruta>]");
    const name = args[index].slice(2);
    if (!["installer", "tag", "output"].includes(name)) throw new Error(`Opcion desconocida: --${name}`);
    options[name] = args[index + 1];
  }
  return options;
}

function run(args) {
  const options = parseArgs(args);
  const version = require(path.join(frontend, "package.json")).version;
  const config = JSON.parse(fs.readFileSync(path.join(frontend, "src-tauri/tauri.conf.json"), "utf8"));
  if (version !== config.version) throw new Error("package.json y tauri.conf.json tienen versiones distintas.");
  const installerPath = path.resolve(options.installer || path.join(frontend,
    `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ScisoNomics_${version}_x64-setup.exe`));
  const manifest = createManifest({ installerPath, version, tag: options.tag || `v${version}` });
  const outputPath = path.resolve(options.output || path.join(path.dirname(installerPath), "latest.json"));
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  console.log(`Manifest generado: ${outputPath}`);
  console.log(`Version: ${version}; plataforma: windows-x86_64; asset: ${path.basename(installerPath)}`);
  return outputPath;
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`No se genero latest.json: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createManifest, parseArgs, run };

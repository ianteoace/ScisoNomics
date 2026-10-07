const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const root = path.resolve(__dirname,"..");
const read = file => JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
function config(env) { const context={process:{env},module:{exports:{}}};vm.runInNewContext(fs.readFileSync(path.join(root,"next.config.js"),"utf8"),context);return context.module.exports; }
test("desktop concurrent launcher fixes port and isolates development output",()=>{
 const {desktopDevCommand,tauriDevCommand}=require("../../scripts/dev-desktop-concurrent.cjs");const input={PORT:"3000",TAURI_ENV_PLATFORM:"windows"};const command=desktopDevCommand(input);
 assert.deepEqual(command.args.slice(1),["dev","--webpack","-p","3001"]);assert.equal(input.SCISONOMICS_DESKTOP_CONCURRENT_DEV,undefined);
 const next=config({...command.env,NODE_ENV:"development"});assert.equal(next.assetPrefix,"http://localhost:3001");assert.equal(next.distDir,".next-desktop-dev");
 const tauri=tauriDevCommand(input,["--no-watch"]);assert.equal(tauri.env.SCISONOMICS_DESKTOP_CONCURRENT_DEV,"1");assert.deepEqual(tauri.args.slice(1),["dev","--config","src-tauri/tauri.desktop.concurrent.conf.json","--no-watch"]);
});
test("Android, regular desktop and production retain their settings even with concurrent flag",()=>{
 const flag={SCISONOMICS_DESKTOP_CONCURRENT_DEV:"1"};const android=config({NODE_ENV:"development",TAURI_ENV_PLATFORM:"android",...flag});assert.equal(android.assetPrefix,"http://localhost:3000");assert.equal(android.distDir,undefined);
 const normal=config({NODE_ENV:"development",TAURI_DEV_HOST:"127.0.0.1"});assert.equal(normal.assetPrefix,"http://127.0.0.1:3000");assert.equal(normal.distDir,undefined);
 const prod=config({NODE_ENV:"production",...flag});assert.equal(prod.assetPrefix,undefined);assert.equal(prod.distDir,undefined);assert.equal(prod.output,"export");
});
test("Tauri concurrent override is dev-only with exact staging CSP and no native/security changes",()=>{
 const extra=read("src-tauri/tauri.desktop.concurrent.conf.json"),base=read("src-tauri/tauri.conf.json"),scripts=read("package.json").scripts;
 assert.equal(extra.build.devUrl,"http://localhost:3001");assert.equal(extra.build.beforeDevCommand,"npm run dev:desktop:concurrent");assert.equal(extra.build.frontendDist,undefined);
 assert.equal(extra.plugins,undefined);assert.equal(extra.identifier,undefined);assert.equal(extra.version,undefined);assert.equal(extra.app.windows,undefined);assert.equal(extra.app.security.capabilities,undefined);assert.equal(extra.app.security.csp,undefined);
 for(const url of ["https://marvelous-intuition-staging.up.railway.app","https://ktfrqbghsrfmfkzzapkh.supabase.co"])assert.ok(extra.app.security.devCsp.includes(url));assert.ok(!extra.app.security.devCsp.includes("connect-src *"));
 assert.equal(base.build.devUrl,"http://127.0.0.1:3000");assert.equal(base.build.beforeDevCommand,"npm run dev");assert.equal(scripts.dev,"next dev --webpack -p 3000");assert.equal(scripts["tauri:dev"],"tauri dev");assert.equal(scripts["dev:mobile"],"next dev --webpack -p 3000 --hostname 0.0.0.0");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  });
  module._compile(outputText, filename);
};
const root = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "src-tauri/migrations/0001_mobile_finance.sql"), "utf8");
const planningSchema = fs.readFileSync(path.join(root, "src-tauri/migrations/0002_mobile_planning.sql"), "utf8");
const schedulingSchema = fs.readFileSync(path.join(root, "src-tauri/migrations/0003_mobile_scheduling.sql"), "utf8");
const pushSchema = fs.readFileSync(path.join(root, "src-tauri/migrations/0005_mobile_cloud_push.sql"), "utf8");
const pullSchema = fs.readFileSync(path.join(root, "src-tauri/migrations/0004_mobile_cloud_pull.sql"), "utf8");
const corePath = require.resolve("@tauri-apps/api/core");
const driverPath = require.resolve("@tauri-apps/plugin-sql");
const apiPath = path.join(root, "services/api.ts");
const movement = { fecha: "2026-10-04", tipo: "ingreso", categoria_id: 1, descripcion: "Ingreso demo", monto: 10000 };
const period = { year: 2026, month: 10 };

test("financial owner resolver uses only authorized internal users.id and logout returns local", () => {
  const { resolveMobileFinancialOwner: resolve } = require('../services/data/mobileFinancialContext.ts');
  const account = {authProvider:'supabase',user:{id:'internal-owner',auth_provider_id:'provider-sub',email:'owner@example.test'}};
  assert.equal(resolve(null,false),'local');
  assert.equal(resolve(account,false),'local');
  assert.equal(resolve(account,true),'internal-owner');
  assert.equal(resolve({...account,authProvider:'legacy'},true),'local');
  assert.equal(resolve({...account,user:{email:'owner@example.test',auth_provider_id:'provider-sub'}},true),'local');
  assert.equal(resolve(null,true),'local');
});

test("normal repositories isolate account/local CRUD, category IDs and every aggregate in real SQLite", async t => {
  const state=fixture(t), m=state.modules();
  const a=m.createMobileFinanceRepository('owner-a'),b=m.createMobileFinanceRepository('owner-b'),local=m.mobileFinanceRepository;
  for(const [repo,amount] of [[local,99999],[b,77777],[a,1000]]) {
    await repo.createCategoria({nombre:'General',tipo:'ingreso'});
    await repo.createMovimiento({...movement,categoria_id:(await repo.listCategorias())[0].id,monto:amount});
  }
  const db=state.databases[0],before=JSON.stringify(['categorias','movimientos'].map(table=>db.prepare(`SELECT * FROM ${table} WHERE owner_user_id='local'`).all()));
  const row=(await a.listMovimientos(period))[0],foreign=(await b.listMovimientos(period))[0];
  assert.equal(row.monto,1000); assert.equal((await local.listMovimientos(period))[0].monto,99999);
  assert.equal((await a.getSummary(period)).saldo,1000);
  assert.equal((await a.getStatistics(period)).summary.ingreso,1000);
  assert.equal((await a.getMonthlyReport(period)).ingresos,1000);
  assert.equal((await a.getAnnualStatistics(2026)).monthly.find(x=>x.mes===10).ingresos,1000);
  await assert.rejects(a.createMovimiento({...movement,categoria_id:foreign.categoria_id}));
  await assert.rejects(a.updateMovimiento(foreign.id,{...movement,categoria_id:row.categoria_id}));
  await assert.rejects(a.deleteMovimiento(foreign.id));
  await assert.rejects(a.updateCategoria(foreign.categoria_id,{nombre:'Ajena',tipo:'ingreso'}));
  await assert.rejects(a.deleteCategoria(foreign.categoria_id));
  const identity=db.prepare('SELECT sync_id FROM movimientos WHERE id=?').get(row.id).sync_id;
  db.prepare("UPDATE movimientos SET sync_status='synced' WHERE id=?").run(row.id);
  await a.updateMovimiento(row.id,{...movement,categoria_id:row.categoria_id,monto:1200});
  let saved=db.prepare('SELECT * FROM movimientos WHERE id=?').get(row.id);
  assert.equal(saved.sync_status,'pending');assert.equal(saved.sync_id,identity);assert.equal(saved.local_change_version,1);
  await a.deleteMovimiento(row.id);saved=db.prepare('SELECT * FROM movimientos WHERE id=?').get(row.id);
  assert.ok(saved.deleted_at);assert.equal(saved.sync_status,'pending');assert.equal(saved.sync_id,identity);
  assert.deepEqual(await a.listMovimientos(period),[]);assert.equal((await a.getSummary(period)).saldo,0);
  assert.equal((await b.listMovimientos(period)).length,1);
  assert.equal(JSON.stringify(['categorias','movimientos'].map(table=>db.prepare(`SELECT * FROM ${table} WHERE owner_user_id='local'`).all())),before);
  assert.equal(state.desktopCalls.length,0);
});

test("cloud financial reports never consume local planning and cloud planning writes fail closed",async t=>{
  const state=fixture(t),m=state.modules(),local=m.mobileFinanceRepository,a=m.createMobileFinanceRepository('owner-a');
  await local.createCategoria({nombre:'Gasto local',tipo:'gasto'});
  const category=(await local.listCategorias())[0];
  await local.createPresupuesto({categoria_id:category.id,mes:10,anio:2026,monto:1});
  await local.createMeta({nombre:'Local',monto_objetivo:100,monto_inicial:0,estado:'activa',fecha_objetivo:null,descripcion:''});
  await local.createMovimiento({...movement,tipo:'gasto',categoria_id:category.id,monto:20});
  const report=await a.getMonthlyReport(period);assert.deepEqual(report.metas,[]);assert.deepEqual(report.presupuestos_excedidos,[]);
  assert.deepEqual(await a.listGastosProgramados(),[]);assert.equal((await a.getStatistics(period)).planificacion.total_pendiente_30_dias,0);
  await assert.rejects(a.createPresupuesto({categoria_id:category.id,mes:10,anio:2026,monto:5}),/Datos locales/);
  await assert.rejects(a.markGastoProgramadoPaid(1),/Datos locales/);
});

test("invalidated financial context refuses delayed or stale mutations without changing either owner",async t=>{
  const state=fixture(t),m=state.modules();let valid=true;
  const a=m.createMobileFinanceRepository('owner-a',()=>valid);
  await a.createCategoria({nombre:'Propia',tipo:'ingreso'});const category=(await a.listCategorias())[0];
  const db=state.databases[0],before=JSON.stringify(db.prepare('SELECT * FROM categorias').all());
  const delayed=a.createCategoria({nombre:'No debe guardarse',tipo:'ingreso'});
  valid=false;
  await assert.rejects(delayed,/cuenta activa cambió/);
  await assert.rejects(a.createMovimiento({...movement,categoria_id:category.id}),/cuenta activa cambió/);
  await assert.rejects(a.updateCategoria(category.id,{nombre:'Obsoleta',tipo:'ingreso'}),/cuenta activa cambió/);
  await assert.rejects(a.deleteCategoria(category.id),/cuenta activa cambió/);
  const queries=state.statements.length;
  for(const read of [()=>a.listCategorias(),()=>a.listMovimientos(period),()=>a.getSummary(period),()=>a.getStatistics(period),()=>a.getMonthlyReport(period),()=>a.getAnnualStatistics(2026)]) await assert.rejects(read());
  assert.equal(state.statements.length,queries);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM categorias').all()),before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movimientos').get().n,0);
});

function fixture(t, filename = ":memory:") {
  const previousWindow = global.window;
  const previousCore = require.cache[corePath];
  const previousDriver = require.cache[driverPath], previousApi = require.cache[apiPath];
  global.window = { __TAURI_INTERNALS__: {}, navigator: { userAgent: "Android" } };
  const state = { loads: 0, statements: [], databases: [], failLoads: false, disableFK: false, omitMigration: false, failWrites: false, desktopCalls: [] };
  // node:sqlite uses anonymous positional parameters; SQLx accepts $1/$2.
  function bind(raw, sql, params) {
    const values = [];
    const query = sql.replace(/\$(\d+)/g, (_, index) => { values.push(params[Number(index) - 1]); return "?"; });
    return { statement: raw.prepare(query), values };
  }
  class Driver {
    static async load(url) {
      state.loads++;
      assert.equal(url, "sqlite:scisonomics-mobile.db");
      if (state.failLoads) throw new Error("private/path native load error");
      const raw = new DatabaseSync(filename);
      raw.exec("CREATE TABLE IF NOT EXISTS _sqlx_migrations(version INTEGER PRIMARY KEY, success INTEGER)");
      if (!raw.prepare("SELECT 1 FROM _sqlx_migrations WHERE version=1").get()) { raw.exec(schema); raw.exec("INSERT INTO _sqlx_migrations VALUES(1,1)"); }
      if (!raw.prepare("SELECT 1 FROM _sqlx_migrations WHERE version=2").get()) { raw.exec(planningSchema); raw.exec("INSERT INTO _sqlx_migrations VALUES(2,1)"); }
      if (!raw.prepare("SELECT 1 FROM _sqlx_migrations WHERE version=3").get()) { raw.exec(schedulingSchema); raw.exec("INSERT INTO _sqlx_migrations VALUES(3,1)"); }
      if (!raw.prepare("SELECT 1 FROM _sqlx_migrations WHERE version=4").get()) { raw.exec(pullSchema); raw.exec("INSERT INTO _sqlx_migrations VALUES(4,1)"); }
      if (!raw.prepare("SELECT 1 FROM _sqlx_migrations WHERE version=5").get()) { raw.exec(pushSchema); raw.exec("INSERT INTO _sqlx_migrations VALUES(5,1)"); }
      if (state.omitSchedulingMigration) raw.exec("DELETE FROM _sqlx_migrations WHERE version=3");
      if (state.disableFK) raw.exec("PRAGMA foreign_keys = OFF");
      if (state.omitMigration) raw.exec("DELETE FROM _sqlx_migrations");
      if (state.omitPlanningMigration) raw.exec("DELETE FROM _sqlx_migrations WHERE version=2");
      state.databases.push(raw);
      return {
        select: async (sql, params = []) => { state.statements.push({ sql, params }); if(state.failReads) throw new Error("SELECT private/path account-secret"); const { statement, values } = bind(raw, sql, params); return statement.all(...values); },
        execute: async (sql, params = []) => {
          state.statements.push({ sql, params });
          if (state.failWrites) throw new Error("INSERT private financial body");
          const { statement, values } = bind(raw, sql, params);
          const result = statement.run(...values);
          return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
        },
        close: async () => { raw.close(); state.databases = state.databases.filter((db) => db !== raw); },
      };
    }
  }
  require.cache[driverPath] = { id: driverPath, filename: driverPath, loaded: true, exports: { __esModule: true, default: Driver } };
  require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: { invoke: async (name, { statements }) => {
    assert.equal(name, "mobile_sql_transaction");
    const raw = state.databases.at(-1); raw.exec("BEGIN IMMEDIATE");
    try {
      const changes = statements.map(({ sql, values }, index) => {
        if (state.failTransactionAt === index) throw new Error("private SQL transaction error");
        state.statements.push({ sql, params: values });
        const bound = bind(raw, sql, values); return Number(bound.statement.run(...bound.values).changes);
      });
      raw.exec("COMMIT"); return changes;
    } catch (error) { raw.exec("ROLLBACK"); throw error; }
  } } };
  const api = Object.fromEntries(["categorias", "createCategoria", "updateCategoria", "deleteCategoria", "movimientos", "createMovimiento", "updateMovimiento", "deleteMovimiento", "gastosFijos", "createGastoFijo", "updateGastoFijo", "deleteGastoFijo", "presupuestos", "upsertPresupuesto", "deletePresupuesto", "metas", "createMeta", "updateMeta", "deleteMeta", "gastosProgramados", "createGastoProgramado", "updateGastoProgramado", "deleteGastoProgramado", "marcarPagado", "stats", "calendario", "statsAnual", "reporteMensual"].map((name) => [name, async (...args) => {
    state.desktopCalls.push({ name, args });
    return name === "categorias" ? [{ id: 41, nombre: "Desktop", tipo: "gasto" }] : name === "movimientos" ? { rows: [{ ...movement, id: 42, categoria: "Desktop", saldo_acumulado: 10000 }], summary: { saldo_inicial: 700 } } : name === "stats" ? { planificacion: { balance_proyectado_mes: 0 } } : { ok: true };
  }]));
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { api } };
  function modules() {
    for (const cached of Object.keys(require.cache)) if (cached.startsWith(path.join(root, "services/data"))) delete require.cache[cached];
    return { ...require("../services/data/mobileDatabase.ts"), ...require("../services/data/mobileFinanceRepository.ts"), ...require("../services/data/financeRepository.ts"), ...require("../services/data/financeSummary.ts") };
  }
  t.after(() => {
    for (const db of state.databases) db.close();
    global.window = previousWindow;
    if (previousCore) require.cache[corePath] = previousCore; else delete require.cache[corePath];
    if (previousDriver) require.cache[driverPath] = previousDriver; else delete require.cache[driverPath];
    if (previousApi) require.cache[apiPath] = previousApi; else delete require.cache[apiPath];
  });
  return Object.assign(state, { modules });
}

test("repository contract selects mobile without any desktop API calls", async (t) => {
  const state = fixture(t), m = state.modules();
  const repository = await m.getFinanceRepository();
  assert.equal(repository, m.mobileFinanceRepository);
  assert.deepEqual(Object.keys(repository).sort(), ["createCategoria", "createMovimiento", "deleteCategoria", "deleteMovimiento", "getSummary", "listCategorias", "listMovimientos", "updateCategoria", "updateMovimiento", "listGastosFijos", "createGastoFijo", "updateGastoFijo", "deleteGastoFijo", "listPresupuestos", "createPresupuesto", "updatePresupuesto", "deletePresupuesto", "listMetas", "createMeta", "updateMeta", "deleteMeta", "listGastosProgramados", "createGastoProgramado", "updateGastoProgramado", "deleteGastoProgramado", "markGastoProgramadoPaid", "getSchedulingSummary", "getCalendar", "getStatistics", "getMonthlyReport", "getAnnualStatistics"].sort());
  await repository.createCategoria({ nombre: "Prueba Mobile", tipo: "ingreso" });
  await repository.createMovimiento(movement);
  assert.equal((await repository.listCategorias())[0].id, 1);
  assert.equal((await repository.listMovimientos(period))[0].categoria, "Prueba Mobile");
  assert.deepEqual(state.desktopCalls, []);
});

test("desktop and browser repositories delegate payloads and period to the existing API", async (t) => {
  const state = fixture(t), m = state.modules();
  for (const native of [true, false]) {
    global.window = { ...(native ? { __TAURI_INTERNALS__: {} } : {}), navigator: { userAgent: "Windows NT" } };
    const repository = await m.getFinanceRepository();
    assert.equal((await repository.listCategorias("gasto"))[0].id, 41);
    await repository.createCategoria({ nombre: "Desktop", tipo: "gasto" });
    assert.equal((await repository.listMovimientos(period))[0].id, 42);
    await repository.createMovimiento(movement);
    assert.deepEqual(state.desktopCalls.splice(0), [
      { name: "categorias", args: ["gasto"] }, { name: "createCategoria", args: [{ nombre: "Desktop", tipo: "gasto" }] },
      { name: "movimientos", args: [10, 2026, "todos", ""] }, { name: "createMovimiento", args: [movement] },
    ]);
  }
  assert.equal(state.loads, 0);
});

test("SQLite is lazy, reused by concurrent callers and guarded even after caching", async (t) => {
  const state = fixture(t), m = state.modules();
  assert.equal(state.loads, 0);
  const [a, b] = await Promise.all([m.getMobileDatabase(), m.getMobileDatabase()]);
  assert.equal(a, b); assert.equal(state.loads, 1);
  global.window.navigator.userAgent = "Windows NT";
  await assert.rejects(m.getMobileDatabase(), /only available/);
  global.window = undefined;
  await assert.rejects(m.getMobileDatabase(), /only available/);
  assert.equal(state.loads, 1);
});

test("failed initialization is sanitized, retryable and checks migration and foreign keys", async (t) => {
  const state = fixture(t), m = state.modules();
  for (const flag of ["failLoads", "disableFK", "omitMigration", "omitPlanningMigration", "omitSchedulingMigration"]) {
    state[flag] = true;
    await assert.rejects(m.getMobileDatabase(), (error) => {
      assert.match(error.message, /almacenamiento local/); assert.doesNotMatch(error.message, /private|SELECT/); return true;
    });
    state[flag] = false;
  }
  await m.getMobileDatabase(); assert.equal(state.loads, 6);
});

test("new local records have independent UUIDs, timestamps, pending status and valid mapping", async (t) => {
  const state = fixture(t), m = state.modules(), repository = m.mobileFinanceRepository;
  await repository.createCategoria({ nombre: " Prueba Mobile ", tipo: "ingreso" });
  await repository.createMovimiento({ ...movement, descripcion: " Ingreso demo ", nota: " Nota " });
  const [row] = await repository.listMovimientos(period);
  assert.deepEqual(row, { id: 1, fecha: "2026-10-04", tipo: "ingreso", categoria: "Prueba Mobile", descripcion: "Ingreso demo", monto: 10000, saldo_acumulado: 10000, nota: "Nota", categoria_id: 1, meta_id: null });
  const raw = state.databases[0];
  for (const table of ["categorias", "movimientos"]) {
    const stored = raw.prepare(`SELECT * FROM ${table}`).get();
    assert.equal(stored.owner_user_id, "local"); assert.equal(stored.sync_status, "pending");
    assert.match(stored.sync_id, /^[a-f0-9-]{36}$/); assert.notEqual(stored.sync_id, "local");
    assert.ok(stored.created_at); assert.equal(stored.created_at, stored.updated_at); assert.equal(stored.deleted_at, null);
  }
  assert.notEqual(raw.prepare("SELECT sync_id FROM categorias").get().sync_id, raw.prepare("SELECT sync_id FROM movimientos").get().sync_id);
  assert.deepEqual(m.mapCategoria({ id: 7, nombre: "Categoría", tipo: "ahorro", internal: "hidden" }), { id: 7, nombre: "Categoría", tipo: "ahorro" });
  assert.equal(m.mapMovimiento({ ...row, descripcion: null, nota: null }).descripcion, "");
});

test("SQL bindings preserve quoted input instead of executing it", async (t) => {
  const state = fixture(t), m = state.modules();
  const nombre = "Prueba '); DROP TABLE movimientos; --";
  await m.mobileFinanceRepository.createCategoria({ nombre, tipo: "gasto" });
  assert.equal((await m.mobileFinanceRepository.listCategorias())[0].nombre, nombre);
  assert.equal(state.databases[0].prepare("SELECT count(*) AS n FROM movimientos").get().n, 0);
  const insert = state.statements.find((q) => q.sql.startsWith("INSERT INTO categorias"));
  assert.ok(!insert.sql.includes(nombre)); assert.equal(insert.params[0], nombre);
});

test("validation rejects invalid amounts, dates, types, text and periods before database load", async (t) => {
  const state = fixture(t), m = state.modules();
  for (const monto of [0, -1, NaN, Infinity, 1.001, Number.MAX_VALUE]) await assert.rejects(m.mobileFinanceRepository.createMovimiento({ ...movement, monto }), /monto/);
  for (const fecha of ["2026-02-29", "2026-13-01", "2026-10-32", "2026-1-1", "garbage", "0000-01-01"]) await assert.rejects(m.mobileFinanceRepository.createMovimiento({ ...movement, fecha }), /fecha/);
  for (const categoria_id of [0, -1, 1.5]) await assert.rejects(m.mobileFinanceRepository.createMovimiento({ ...movement, categoria_id }), /categoría/);
  await assert.rejects(m.mobileFinanceRepository.createCategoria({ nombre: " ", tipo: "gasto" }), /obligatorio/);
  await assert.rejects(m.mobileFinanceRepository.createCategoria({ nombre: "x".repeat(121), tipo: "gasto" }), /120/);
  await assert.rejects(m.mobileFinanceRepository.createCategoria({ nombre: "A", tipo: "other" }), /tipo/);
  await assert.rejects(m.mobileFinanceRepository.createMovimiento({ ...movement, descripcion: "x".repeat(501) }), /500/);
  await assert.rejects(m.mobileFinanceRepository.listMovimientos({ year: 2026, month: 13 }), /mes/);
  assert.equal(m.validateMovimiento({ ...movement, fecha: "2028-02-29" }).fecha, "2028-02-29");
  assert.equal(state.loads, 0);
});

test("missing, foreign-owner and deleted categories cannot receive local movements", async (t) => {
  const state = fixture(t), m = state.modules(), repository = m.mobileFinanceRepository;
  await assert.rejects(repository.createMovimiento(movement), /no existe/);
  const raw = state.databases[0];
  raw.prepare("INSERT INTO categorias (nombre, tipo, owner_user_id, sync_id) VALUES(?, ?, ?, ?)").run("Cloud", "ingreso", "other-owner", "cloud-id");
  await assert.rejects(repository.createMovimiento(movement), /no existe/);
  assert.throws(() => raw.prepare("INSERT INTO movimientos(fecha, tipo, categoria_id, monto, sync_id) VALUES(?, ?, ?, ?, ?)").run("2026-10-04", "ingreso", 1, 10, "invalid"), /FOREIGN KEY/);
  raw.exec("UPDATE categorias SET owner_user_id='local', deleted_at=CURRENT_TIMESTAMP");
  await assert.rejects(repository.createMovimiento(movement), /no existe/);
  assert.deepEqual(await repository.listCategorias(), []);
});

test("duplicate categories and driver failures return clear errors without SQL details", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  const category = { nombre: "Prueba Mobile", tipo: "ingreso" };
  await repository.createCategoria(category);
  await assert.rejects(repository.createCategoria(category), /Ya existe/);
  state.failWrites = true;
  await assert.rejects(repository.createMovimiento(movement), (e) => { assert.match(e.message, /guardar/); assert.doesNotMatch(e.message, /private|INSERT/); return true; });
});

test("lists and cumulative balances exclude another owner and tombstones and handle year boundaries", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Prueba", tipo: "ingreso" });
  await repository.createMovimiento({ ...movement, fecha: "2025-12-31", monto: 700 });
  await repository.createMovimiento({ ...movement, fecha: "2026-01-01", monto: 200 });
  await repository.createMovimiento({ ...movement, fecha: "2026-01-02", tipo: "gasto", monto: 50 });
  await repository.createMovimiento({ ...movement, fecha: "2026-01-03", monto: 9000 });
  const raw = state.databases[0];
  raw.exec("UPDATE movimientos SET deleted_at=CURRENT_TIMESTAMP WHERE id=4");
  raw.exec("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Cloud','ingreso','cloud','cloud-category'); INSERT INTO movimientos(fecha,tipo,categoria_id,monto,owner_user_id,sync_id) VALUES('2026-01-01','ingreso',2,99999,'cloud','cloud-movement')");
  const rows = await repository.listMovimientos({ year: 2026, month: 1 });
  assert.deepEqual(rows.map((r) => r.saldo_acumulado), [850, 900]);
  assert.equal(rows.length, 2);
  assert.equal((await repository.listMovimientos({ year: 2025, month: 12 }))[0].saldo_acumulado, 700);
});

test("migration v1 is idempotent and rejects invalid direct writes", async (t) => {
  const state = fixture(t), m = state.modules();
  await m.mobileFinanceRepository.createCategoria({ nombre: "Prueba", tipo: "gasto" });
  const raw = state.databases[0]; raw.exec(schema);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM categorias").get().n, 1);
  for (const [fecha, tipo, monto] of [["2026-02-30", "gasto", 10], ["2026-01-01", "other", 10], ["2026-01-01", "gasto", 0]]) {
    assert.throws(() => raw.prepare("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,sync_id) VALUES(?, ?, 1, ?, 'bad')").run(fecha, tipo, monto), /CHECK/);
  }
  assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%' ORDER BY name").all().map((r) => r.name), ["categorias", "gastos_fijos", "gastos_programados", "metas_ahorro", "mobile_pull_state", "movimientos", "presupuestos"]);
});

test("saved demo data survives closing and reopening the database with balance 7500", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-mobile-test-"));
  const state = fixture(t, path.join(temp, "mobile.db"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(), repository = m.mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Prueba Mobile", tipo: "ingreso" });
  await repository.createMovimiento(movement);
  await repository.createMovimiento({ ...movement, tipo: "gasto", monto: 2500, descripcion: "Gasto demo" });
  assert.deepEqual(m.calculateFinanceSummary(await repository.listMovimientos(period)), { ingresos: 10000, gastos: 2500, ahorros: 0, inversiones: 0, balance: 7500, saldoInicial: 0, saldo: 7500 });
  await (await m.getMobileDatabase()).close();
  m = state.modules(); repository = m.mobileFinanceRepository;
  assert.equal((await repository.listCategorias())[0].nombre, "Prueba Mobile");
  const rows = await repository.listMovimientos(period);
  assert.equal(rows.length, 2);
  assert.deepEqual(m.calculateFinanceSummary(rows), { ingresos: 10000, gastos: 2500, ahorros: 0, inversiones: 0, balance: 7500, saldoInicial: 0, saldo: 7500 });
});

test("demo operating summary handles decimals and negative balances without savings double counting", (t) => {
  const m = fixture(t).modules();
  assert.deepEqual(m.calculateFinanceSummary([]), { ingresos: 0, gastos: 0, ahorros: 0, inversiones: 0, balance: 0, saldoInicial: 0, saldo: 0 });
  assert.deepEqual(m.calculateFinanceSummary([{ tipo: "ingreso", monto: 0.1 }, { tipo: "ingreso", monto: 0.2 }, { tipo: "gasto", monto: 10 }, { tipo: "ahorro", monto: 500 }, { tipo: "inversion", monto: 900 }]), { ingresos: 0.3, gastos: 10, ahorros: 500, inversiones: 900, balance: -9.7, saldoInicial: 0, saldo: -1409.7 });
});

test("updates preserve identity, creation time and owner and refresh the dashboard", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Ingreso Mobile", tipo: "ingreso" });
  await repository.createCategoria({ nombre: "Gasto Mobile", tipo: "gasto" });
  await repository.createMovimiento(movement);
  await repository.createMovimiento({ ...movement, tipo: "gasto", categoria_id: 2, monto: 2500 });
  const raw = state.databases[0];
  raw.exec("UPDATE movimientos SET updated_at='2000-01-01',sync_status='synced' WHERE id=2");
  const before = raw.prepare("SELECT * FROM movimientos WHERE id=2").get();
  await repository.updateMovimiento(2, { ...movement, tipo: "gasto", categoria_id: 2, monto: 3000, descripcion: "Gasto editado", nota: "Nota editada" });
  const after = raw.prepare("SELECT * FROM movimientos WHERE id=2").get();
  for (const key of ["id", "sync_id", "created_at", "owner_user_id"]) assert.equal(after[key], before[key]);
  assert.notEqual(after.updated_at, before.updated_at); assert.equal(after.sync_status, "pending");
  assert.equal((await repository.getSummary(period)).saldo, 7000);
  assert.equal((await repository.listMovimientos(period))[0].nota, "Nota editada");
  raw.exec("UPDATE categorias SET updated_at='2000-01-01',sync_status='synced' WHERE id=2");
  const category = raw.prepare("SELECT * FROM categorias WHERE id=2").get();
  await repository.updateCategoria(2, { nombre: "Gasto renombrado", tipo: "gasto" });
  const renamed = raw.prepare("SELECT * FROM categorias WHERE id=2").get();
  for (const key of ["id", "sync_id", "created_at", "owner_user_id"]) assert.equal(renamed[key], category[key]);
  assert.notEqual(renamed.updated_at, category.updated_at); assert.equal(renamed.sync_status, "pending");
  assert.equal((await repository.listMovimientos(period))[0].categoria, "Gasto renombrado");
});

test("used categories are protected; deletion creates durable tombstones without breaking FK", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Prueba", tipo: "ingreso" });
  await repository.createMovimiento(movement);
  await assert.rejects(repository.deleteCategoria(1), /movimientos asociados/);
  assert.equal((await repository.listCategorias()).length, 1);
  await repository.deleteMovimiento(1);
  assert.equal((await repository.listMovimientos(period)).length, 0);
  assert.equal((await repository.getSummary(period)).saldo, 0);
  await assert.rejects(repository.updateMovimiento(1, movement));
  await repository.deleteCategoria(1);
  assert.equal((await repository.listCategorias()).length, 0);
  const raw = state.databases[0];
  for (const table of ["categorias", "movimientos"]) {
    const row = raw.prepare(`SELECT * FROM ${table}`).get();
    assert.ok(row.deleted_at); assert.equal(row.updated_at, row.deleted_at); assert.equal(row.sync_status, "pending");
  }
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  await assert.rejects(repository.createMovimiento(movement), /categoría seleccionada/);
  // v1 uniqueness includes tombstones, matching desktop. No hidden resurrection.
  await assert.rejects(repository.createCategoria({ nombre: "Prueba", tipo: "ingreso" }), /Ya existe/);
});

test("CRUD rejects invalid IDs, duplicate categories, inactive references and another owner", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Local", tipo: "ingreso" });
  await repository.createCategoria({ nombre: "Otra", tipo: "ingreso" });
  await repository.createMovimiento(movement);
  await assert.rejects(repository.updateCategoria(2, { nombre: "Local", tipo: "ingreso" }), /ya existe/);
  await assert.rejects(repository.updateMovimiento(1, { ...movement, monto: 0 }), /mayor a cero/);
  for (const id of [0, -1, 1.5, NaN]) {
    await assert.rejects(repository.updateMovimiento(id, movement), /registro válido/);
    await assert.rejects(repository.deleteMovimiento(id), /registro válido/);
    await assert.rejects(repository.updateCategoria(id, { nombre: "Prueba", tipo: "gasto" }), /registro válido/);
    await assert.rejects(repository.deleteCategoria(id), /registro válido/);
  }
  const raw = state.databases[0];
  raw.exec("INSERT INTO categorias(id,nombre,tipo,owner_user_id,sync_id) VALUES(10,'Cloud','ingreso','cloud','cloud-cat'); INSERT INTO movimientos(id,fecha,tipo,categoria_id,monto,owner_user_id,sync_id) VALUES(10,'2026-10-04','ingreso',10,999,'cloud','cloud-mov')");
  await assert.rejects(repository.updateMovimiento(10, movement));
  await assert.rejects(repository.deleteMovimiento(10));
  await assert.rejects(repository.updateCategoria(10, { nombre: "Ataque", tipo: "gasto" }));
  await assert.rejects(repository.deleteCategoria(10));
  await assert.rejects(repository.updateMovimiento(1, { ...movement, categoria_id: 10 }));
  assert.equal(raw.prepare("SELECT nombre FROM categorias WHERE id=10").get().nombre, "Cloud");
  assert.equal(raw.prepare("SELECT monto FROM movimientos WHERE id=10").get().monto, 999);
});

test("saldo matches desktop historical cutoff, four types, year crossing and empty months", async (t) => {
  const state = fixture(t), repository = state.modules().mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Prueba", tipo: "ingreso" });
  await repository.createMovimiento({ ...movement, fecha: "2025-11-20", monto: 500 });
  await repository.createMovimiento({ ...movement, fecha: "2025-12-31", monto: 200 });
  for (const [tipo, monto] of [["ingreso", 1000], ["gasto", 300], ["ahorro", 100], ["inversion", 50]]) {
    await repository.createMovimiento({ ...movement, fecha: "2026-01-01", tipo, monto });
  }
  await repository.createMovimiento({ ...movement, fecha: "2026-03-01", monto: 99999 });
  const expected = { ingresos: 1000, gastos: 300, ahorros: 100, inversiones: 50, balance: 700, saldoInicial: 700, saldo: 1250 };
  assert.deepEqual(await repository.getSummary({ year: 2026, month: 1 }), expected);
  assert.deepEqual(await repository.getSummary({ year: 2026, month: 2 }), { ingresos: 0, gastos: 0, ahorros: 0, inversiones: 0, balance: 0, saldoInicial: 1250, saldo: 1250 });
  assert.equal((await repository.getSummary({ year: 2025, month: 1 })).saldo, 0);
  assert.equal((await repository.getSummary({ year: 2025, month: 12 })).saldo, 700);
  await repository.deleteMovimiento(1);
  assert.equal((await repository.getSummary({ year: 2026, month: 1 })).saldo, 750);
});

test("edits and deletions survive closing and reopening a real SQLite file", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-mobile-crud-"));
  const state = fixture(t, path.join(temp, "mobile.db"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(), repository = m.mobileFinanceRepository;
  await repository.createCategoria({ nombre: "Prueba", tipo: "ingreso" });
  await repository.createMovimiento(movement);
  await repository.updateMovimiento(1, { ...movement, monto: 1234, descripcion: "Persistido" });
  await (await m.getMobileDatabase()).close();
  m = state.modules(); repository = m.mobileFinanceRepository;
  assert.equal((await repository.listMovimientos(period))[0].descripcion, "Persistido");
  assert.equal((await repository.getSummary(period)).saldo, 1234);
  await repository.deleteMovimiento(1); await repository.deleteCategoria(1);
  await (await m.getMobileDatabase()).close();
  m = state.modules(); repository = m.mobileFinanceRepository;
  assert.equal((await repository.listMovimientos(period)).length, 0);
  assert.equal((await repository.listCategorias()).length, 0);
  assert.equal((await repository.getSummary(period)).saldo, 0);
});

test("expanded desktop contract delegates update/delete without opening mobile SQL", async (t) => {
  const state = fixture(t), m = state.modules();
  global.window.navigator.userAgent = "Windows NT";
  const repository = await m.getFinanceRepository();
  await repository.updateMovimiento(42, movement); await repository.deleteMovimiento(42);
  await repository.updateCategoria(41, { nombre: "Desktop editado", tipo: "gasto" }); await repository.deleteCategoria(41);
  assert.deepEqual(state.desktopCalls, [
    { name: "updateMovimiento", args: [42, movement] }, { name: "deleteMovimiento", args: [42] },
    { name: "updateCategoria", args: [41, { nombre: "Desktop editado", tipo: "gasto" }] }, { name: "deleteCategoria", args: [41] },
  ]);
  assert.equal((await repository.getSummary(period)).saldo, 10700);
  assert.equal(state.loads, 0);
});

const fixed = { categoria_id: 1, descripcion: "Alquiler", monto: 500, dia_vencimiento: 31, activo: 1 };
const budget = { categoria_id: 1, mes: 10, anio: 2026, monto: 1000 };
const goal = { nombre: "Viaje", monto_objetivo: 1000, monto_inicial: 100, fecha_objetivo: "2027-01-01", descripcion: "Ahorro asignado", estado: "activa" };
function identity(row) { return [row.id, row.sync_id, row.created_at, row.owner_user_id, row.last_synced_at]; }

test("v1 to v2 upgrade preserves every existing field, tombstones, IDs and balance across reopening", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-planning-upgrade-"));
  const filename = path.join(temp, "mobile.db"), raw = new DatabaseSync(filename);
  raw.exec(schema);
  raw.exec("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY, success INTEGER); INSERT INTO _sqlx_migrations VALUES(1,1)");
  raw.exec("INSERT INTO categorias(nombre,tipo,sync_id) VALUES('Existente','gasto','category-v1')");
  raw.exec("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,sync_id,nota) VALUES('2026-09-30','ingreso',1,700,'income-v1','Historial')");
  raw.exec("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,sync_id,deleted_at) VALUES('2026-10-01','gasto',1,50,'deleted-v1','2026-10-02')");
  const categories = raw.prepare("SELECT * FROM categorias").all(), movements = raw.prepare("SELECT * FROM movimientos ORDER BY id").all().map((r) => ({ ...r })); raw.close();
  const state = fixture(t, filename); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(); await m.getMobileDatabase();
  const upgraded = state.databases[0];
  const oldColumns = (row, baseline) => {
    assert.equal(row.last_remote_updated_at, null); assert.equal(row.last_remote_device_id, null);
    return Object.fromEntries(Object.keys(baseline).map(key => [key, row[key]]));
  };
  assert.deepEqual(upgraded.prepare("SELECT * FROM categorias").all().map(row => oldColumns(row, categories[0])), categories.map(row => ({ ...row })));
  assert.deepEqual(upgraded.prepare("SELECT * FROM movimientos ORDER BY id").all().map(row => { assert.equal(row.meta_id, null); return oldColumns(row, movements[0]); }), movements);
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo, 700);
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  await (await m.getMobileDatabase()).close(); m = state.modules(); await m.getMobileDatabase();
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo, 700);
  assert.deepEqual(state.databases[0].prepare("SELECT version,success FROM _sqlx_migrations ORDER BY version").all().map((r) => ({ ...r })), [{ version: 1, success: 1 }, { version: 2, success: 1 }, { version: 3, success: 1 }, { version: 4, success: 1 }, { version: 5, success: 1 }]);
});

test("fixed expense CRUD preserves identity and persists without generating financial movements", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-fixed-"));
  const state = fixture(t, path.join(temp, "mobile.db")); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Servicios", tipo: "gasto" }); await r.createGastoFijo(fixed);
  const raw = state.databases[0]; raw.exec("UPDATE gastos_fijos SET sync_status='synced', last_synced_at='2025-01-01',updated_at='2025-01-01'");
  const before = raw.prepare("SELECT * FROM gastos_fijos").get();
  await r.updateGastoFijo(1, { ...fixed, monto: 750, activo: 0 });
  const after = raw.prepare("SELECT * FROM gastos_fijos").get();
  assert.deepEqual(identity(after), identity(before)); assert.equal(after.sync_status, "pending"); assert.notEqual(after.updated_at, before.updated_at);
  assert.equal((await r.getSummary(period)).saldo, 0); assert.equal((await r.listMovimientos(period)).length, 0);
  await (await m.getMobileDatabase()).close(); m = state.modules(); r = m.mobileFinanceRepository;
  assert.equal((await r.listGastosFijos())[0].monto, 750); assert.equal((await r.listGastosFijos())[0].activo, 0);
  await r.deleteGastoFijo(1); assert.deepEqual(await r.listGastosFijos(), []);
  await (await m.getMobileDatabase()).close(); m = state.modules();
  assert.deepEqual(await m.mobileFinanceRepository.listGastosFijos(), []);
  assert.ok(state.databases[0].prepare("SELECT deleted_at FROM gastos_fijos").get().deleted_at);
});

test("planning validation rejects invalid data before SQLite is opened", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  for (const c of [{ ...fixed, monto: 0 }, { ...fixed, monto: NaN }, { ...fixed, monto: 1.001 }, { ...fixed, dia_vencimiento: 32 }, { ...fixed, dia_vencimiento: 1.5 }, { ...fixed, activo: 2 }, { ...fixed, descripcion: " " }, { ...fixed, categoria_id: -1 }]) await assert.rejects(r.createGastoFijo(c));
  for (const c of [{ ...budget, monto: 0 }, { ...budget, mes: 0 }, { ...budget, mes: 13 }, { ...budget, anio: 0 }, { ...budget, categoria_id: 0 }]) await assert.rejects(r.createPresupuesto(c));
  for (const c of [{ ...goal, nombre: " " }, { ...goal, nombre: "x".repeat(161) }, { ...goal, descripcion: "x".repeat(2001) }, { ...goal, monto_objetivo: 0 }, { ...goal, monto_inicial: -1 }, { ...goal, estado: "inventado" }, { ...goal, fecha_objetivo: "2026-02-30" }]) await assert.rejects(r.createMeta(c));
  assert.equal(state.loads, 0);
});

test("budgets consume only active same-owner category expenses in their exact period", async (t) => {
  const state = fixture(t), m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Gasto", tipo: "gasto" });
  for (const [fecha, tipo, monto] of [["2026-10-01", "gasto", 400], ["2026-10-02", "gasto", 300], ["2027-01-01", "gasto", 125], ["2026-09-01", "gasto", 100], ["2026-10-01", "ingreso", 1000], ["2026-10-01", "ahorro", 40], ["2026-10-01", "inversion", 50], ["2026-10-03", "gasto", 60]]) await r.createMovimiento({ ...movement, fecha, tipo, monto });
  await r.deleteMovimiento(8);
  const raw = state.databases[0];
  raw.exec("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Ajena','gasto','other','other-cat')");
  raw.exec("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,owner_user_id,sync_id) VALUES('2026-10-01','gasto',2,500,'other','other-move')");
  await r.createPresupuesto(budget);
  let row = (await r.listPresupuestos(period))[0];
  assert.equal(row.monto_gastado, 700); assert.equal(row.monto_disponible, 300); assert.equal(row.porcentaje_usado, 70); assert.equal(row.excedido, false);
  raw.exec("UPDATE presupuestos SET sync_status='synced',last_synced_at='2025-01-01',updated_at='2025-01-01'");
  const before = raw.prepare("SELECT * FROM presupuestos").get();
  await r.updatePresupuesto(1, { ...budget, monto: 600 }); row = (await r.listPresupuestos(period))[0];
  assert.equal(row.monto_disponible, -100); assert.equal(row.excedido, true); assert.ok(row.porcentaje_usado > 100);
  assert.deepEqual(identity(raw.prepare("SELECT * FROM presupuestos").get()), identity(before));
  await assert.rejects(r.updatePresupuesto(1, { ...budget, mes: 11 }), /período/);
  assert.deepEqual(await r.listPresupuestos({ month: 11, year: 2026 }), []);
  await r.createPresupuesto({ ...budget, mes: 1, anio: 2027, monto: 200 });
  assert.equal((await r.listPresupuestos({ month: 1, year: 2027 }))[0].monto_gastado, 125);
  await r.deletePresupuesto(1); assert.deepEqual(await r.listPresupuestos(period), []);
  await r.createPresupuesto({ ...budget, monto: 800 });
  assert.equal((await r.listPresupuestos(period))[0].id, 1);
  assert.deepEqual(identity(raw.prepare("SELECT * FROM presupuestos WHERE id=1").get()), identity(before));
  assert.deepEqual(state.desktopCalls, []);
});

test("goal progress is initial plus explicitly assigned historical savings; state is independent", async (t) => {
  const state = fixture(t), m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Ahorro", tipo: "ahorro" }); await r.createMeta(goal); await r.createMeta({ ...goal, nombre: "Otra" });
  for (const [fecha, tipo, monto, meta_id] of [["2025-01-01", "ahorro", 200, 1], ["2027-01-01", "ahorro", 500, 1], ["2026-10-01", "ahorro", 900, null], ["2026-10-01", "ahorro", 900, 2], ["2026-10-01", "gasto", 500, 1], ["2026-10-02", "ahorro", 100, 1]]) await r.createMovimiento({ ...movement, fecha, tipo, monto, meta_id });
  await r.deleteMovimiento(6);
  let meta = (await r.listMetas()).find((g) => g.id === 1);
  assert.equal(meta.monto_ahorrado, 800); assert.equal(meta.faltante, 200); assert.equal(meta.porcentaje_completado, 80);
  const raw = state.databases[0]; raw.exec("UPDATE metas_ahorro SET sync_status='synced',last_synced_at='2025-01-01',updated_at='2025-01-01' WHERE id=1");
  const before = raw.prepare("SELECT * FROM metas_ahorro WHERE id=1").get();
  await r.updateMeta(1, { ...goal, monto_inicial: 400, estado: "pausada" });
  meta = (await r.listMetas()).find((g) => g.id === 1);
  assert.equal(meta.monto_ahorrado, 1100); assert.equal(meta.faltante, 0); assert.ok(Math.abs(meta.porcentaje_completado - 110) < 1e-10); assert.equal(meta.estado, "pausada");
  assert.deepEqual(identity(raw.prepare("SELECT * FROM metas_ahorro WHERE id=1").get()), identity(before));
  const balance = (await r.getSummary(period)).saldo, moves = raw.prepare("SELECT id,monto,sync_id,created_at FROM movimientos ORDER BY id").all();
  await r.deleteMeta(1);
  assert.equal((await r.listMetas()).length, 1); assert.equal((await r.getSummary(period)).saldo, balance);
  assert.deepEqual(raw.prepare("SELECT id,monto,sync_id,created_at FROM movimientos ORDER BY id").all(), moves);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM movimientos WHERE meta_id=1").get().n, 0);
  assert.equal(raw.prepare("SELECT meta_id FROM movimientos WHERE id=4").get().meta_id, 2);
  await assert.rejects(r.createMovimiento({ ...movement, meta_id: 1 }), /guardar/);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("budgets and goals persist after updates and soft deletion in a real SQLite file", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-goals-"));
  const state = fixture(t, path.join(temp, "mobile.db")); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Gasto", tipo: "gasto" }); await r.createPresupuesto(budget); await r.createMeta(goal);
  await r.updatePresupuesto(1, { ...budget, monto: 2000 }); await r.updateMeta(1, { ...goal, nombre: "Viaje editado", monto_inicial: 250, fecha_objetivo: "2028-02-29" });
  await (await m.getMobileDatabase()).close(); m = state.modules(); r = m.mobileFinanceRepository;
  assert.equal((await r.listPresupuestos(period))[0].monto_presupuestado, 2000);
  const meta = (await r.listMetas())[0]; assert.equal(meta.nombre, "Viaje editado"); assert.equal(meta.fecha_objetivo, "2028-02-29"); assert.equal(meta.monto_ahorrado, 250);
  await r.deleteMeta(1); await r.deletePresupuesto(1);
  await (await m.getMobileDatabase()).close(); m = state.modules();
  assert.deepEqual(await m.mobileFinanceRepository.listMetas(), []); assert.deepEqual(await m.mobileFinanceRepository.listPresupuestos(period), []);
});

test("planning refuses foreign owners, deleted categories and metas; direct FK guards remain active", async (t) => {
  const state = fixture(t), m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Local", tipo: "gasto" }); await r.createMeta(goal);
  const raw = state.databases[0];
  raw.exec("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Ajena','gasto','other','foreign-cat')");
  raw.exec("INSERT INTO metas_ahorro(nombre,monto_objetivo,owner_user_id,sync_id) VALUES('Ajena',100,'other','foreign-goal')");
  raw.exec("INSERT INTO gastos_fijos(categoria_id,descripcion,monto,dia_vencimiento,owner_user_id,sync_id) VALUES(2,'Ajeno',10,1,'other','foreign-fixed')");
  raw.exec("INSERT INTO presupuestos(categoria_id,mes,anio,monto,owner_user_id,sync_id) VALUES(2,10,2026,10,'other','foreign-budget')");
  await assert.rejects(r.createGastoFijo({ ...fixed, categoria_id: 2 })); await assert.rejects(r.createPresupuesto({ ...budget, categoria_id: 2 }));
  await assert.rejects(r.createMovimiento({ ...movement, meta_id: 2 }));
  for (const action of [() => r.updateGastoFijo(1, fixed), () => r.deleteGastoFijo(1), () => r.updatePresupuesto(1, budget), () => r.deletePresupuesto(1), () => r.updateMeta(2, goal), () => r.deleteMeta(2)]) await assert.rejects(action());
  assert.deepEqual(await r.listGastosFijos(), []); assert.deepEqual(await r.listPresupuestos(period), []); assert.equal((await r.listMetas()).length, 1);
  assert.throws(() => raw.exec("INSERT INTO gastos_fijos(categoria_id,descripcion,monto,dia_vencimiento,sync_id) VALUES(2,'Cross owner',10,1,'bad-fixed')"), /FOREIGN KEY/);
  assert.throws(() => raw.exec("INSERT INTO movimientos(fecha,tipo,categoria_id,monto,meta_id,sync_id) VALUES('2026-10-01','ahorro',1,1,2,'bad-meta')"), /invalid meta owner/);
  await r.deleteCategoria(1);
  await assert.rejects(r.createGastoFijo(fixed)); await assert.rejects(r.createPresupuesto(budget));
});

test("deleting an unused category atomically tombstones its planning references without financial deletion", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  await r.createCategoria({ nombre: "Servicios", tipo: "gasto" }); await r.createGastoFijo(fixed); await r.createPresupuesto(budget);
  await r.createMovimiento({ ...movement, tipo: "gasto", monto: 10 });
  await assert.rejects(r.deleteCategoria(1), /movimientos/);
  assert.equal((await r.listGastosFijos()).length, 1); assert.equal((await r.listPresupuestos(period)).length, 1);
  await r.deleteMovimiento(1); await r.deleteCategoria(1);
  assert.deepEqual(await r.listGastosFijos(), []); assert.deepEqual(await r.listPresupuestos(period), []);
  const raw = state.databases[0];
  assert.ok(raw.prepare("SELECT deleted_at FROM gastos_fijos").get().deleted_at); assert.ok(raw.prepare("SELECT deleted_at FROM presupuestos").get().deleted_at);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM movimientos").get().n, 1);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("planning schema constraints and SQL bindings preserve text without executing it", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  await r.createCategoria({ nombre: "Servicios", tipo: "gasto" });
  const text = "Viaje'); DROP TABLE movimientos;--";
  await r.createMeta({ ...goal, nombre: text }); await r.createGastoFijo({ ...fixed, descripcion: text });
  assert.equal((await r.listMetas())[0].nombre, text); assert.equal((await r.listGastosFijos())[0].descripcion, text);
  const raw = state.databases[0];
  for (const sql of ["INSERT INTO gastos_fijos(categoria_id,descripcion,monto,dia_vencimiento,sync_id) VALUES(1,'Test',10,32,'bad-day')",
    "INSERT INTO presupuestos(categoria_id,mes,anio,monto,sync_id) VALUES(1,13,2026,10,'bad-month')",
    "INSERT INTO metas_ahorro(nombre,monto_objetivo,estado,sync_id) VALUES('Test',10,'inventado','bad-state')",
    "INSERT INTO metas_ahorro(nombre,monto_objetivo,fecha_objetivo,sync_id) VALUES('Test',10,'2026-02-30','bad-date')"] ) assert.throws(() => raw.exec(sql), /CHECK/);
  assert.deepEqual(state.desktopCalls, []);
});

test("desktop planning adapter delegates to existing API and never opens SQLite", async (t) => {
  const state = fixture(t), m = state.modules(); global.window.navigator.userAgent = "Windows NT";
  const r = await m.getFinanceRepository();
  await r.listGastosFijos(); await r.createGastoFijo(fixed); await r.updateGastoFijo(1, fixed); await r.deleteGastoFijo(1);
  await r.listPresupuestos(period); await r.createPresupuesto(budget); await r.updatePresupuesto(1, budget); await r.deletePresupuesto(1);
  await r.listMetas(); await r.createMeta(goal); await r.updateMeta(1, goal); await r.deleteMeta(1);
  assert.deepEqual(state.desktopCalls.map((r) => r.name), ["gastosFijos", "createGastoFijo", "updateGastoFijo", "deleteGastoFijo", "presupuestos", "upsertPresupuesto", "upsertPresupuesto", "deletePresupuesto", "metas", "createMeta", "updateMeta", "deleteMeta"]);
  assert.deepEqual(state.desktopCalls[4].args, [10, 2026]); assert.deepEqual(state.desktopCalls[6].args, [budget]); assert.equal(state.loads, 0);
});

const scheduled = { descripcion: "Seguro", categoria_id: 1, monto_estimado: 100, fecha_vencimiento: "2026-10-31", estado: "pendiente", es_recurrente: 1, frecuencia: "mensual" };
const { calendarGrid, adjacentPeriod, localCalendarDate } = require("../services/data/financeCalendar.ts");
const { getLocalDateInputValue } = require("../lib/date.ts");

test("scheduling CRUD persists identity and tombstones without changing real balance or budgets", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scisonomics-scheduling-"));
  const state = fixture(t, path.join(temp, "mobile.db")); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let m = state.modules(), r = m.mobileFinanceRepository;
  await r.createCategoria({ nombre: "Seguro", tipo: "gasto" }); await r.createPresupuesto(budget); await r.createMovimiento(movement);
  await r.createGastoProgramado(scheduled);
  const raw = state.databases[0], before = raw.prepare("SELECT * FROM gastos_programados").get();
  await r.updateGastoProgramado(1, { ...scheduled, monto_estimado: 200, descripcion: "Seguro editado", estado: "pagado", es_recurrente: 0, frecuencia: "mensual" });
  assert.deepEqual(identity(raw.prepare("SELECT * FROM gastos_programados").get()), identity(before));
  assert.equal((await r.getSummary(period)).saldo, 10000); assert.equal((await r.listPresupuestos(period))[0].monto_gastado, 0);
  assert.equal((await r.listGastosProgramados())[0].frecuencia, null);
  await (await m.getMobileDatabase()).close(); m = state.modules(); r = m.mobileFinanceRepository;
  assert.equal((await r.listGastosProgramados("pagado"))[0].descripcion, "Seguro editado");
  await r.deleteGastoProgramado(1); await (await m.getMobileDatabase()).close(); m = state.modules();
  assert.deepEqual(await m.mobileFinanceRepository.listGastosProgramados(), []);
  assert.ok(state.databases[0].prepare("SELECT deleted_at FROM gastos_programados").get().deleted_at);
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo, 10000);
});

test("explicit payment is atomic, idempotent and creates exactly one real expense plus next recurrence", async (t) => {
  const paymentDate = "2026-10-04";
  t.mock.method(require("../lib/date.ts"), "getLocalDateInputValue", () => paymentDate);
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  await r.createCategoria({ nombre: "Seguro", tipo: "gasto" }); await r.createPresupuesto(budget); await r.createGastoProgramado(scheduled);
  state.failTransactionAt = 1;
  await assert.rejects(r.markGastoProgramadoPaid(1), (e) => { assert.match(e.message, /No se guardaron/); assert.doesNotMatch(e.message, /SQL|private/); return true; });
  assert.equal((await r.listMovimientos(period)).length, 0); assert.equal((await r.listGastosProgramados())[0].estado, "pendiente");
  delete state.failTransactionAt;
  const results = await Promise.all([r.markGastoProgramadoPaid(1), r.markGastoProgramadoPaid(1)]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  const moves = await r.listMovimientos(period); assert.equal(moves.length, 1); assert.equal(moves[0].fecha, paymentDate); assert.equal(moves[0].tipo, "gasto");
  assert.equal(moves[0].monto, 100); assert.equal((await r.listPresupuestos(period))[0].monto_gastado, 100);
  const next = (await r.listGastosProgramados("pendiente"))[0]; assert.equal(next.fecha_vencimiento, "2026-11-30");
  assert.equal((await r.getSummary(period)).saldo, -100);
  assert.equal((await r.markGastoProgramadoPaid(1)).changed, false);
  await r.deleteGastoProgramado(1); assert.equal((await r.listMovimientos(period)).length, 1);
});

test("recurrence follows desktop clamping, week/year transitions and next-pending deduplication", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  await r.createCategoria({ nombre: "Seguro", tipo: "gasto" });
  const cases = [["2026-01-31","mensual","2026-02-28"],["2028-01-31","mensual","2028-02-29"],["2026-12-31","mensual","2027-01-31"],["2028-02-29","anual","2029-02-28"],["2026-12-28","semanal","2027-01-04"]];
  for (const [date, frequency, expected] of cases) {
    await r.createGastoProgramado({ ...scheduled, descripcion: date, fecha_vencimiento: date, frecuencia: frequency });
    const current = (await r.listGastosProgramados()).find((row) => row.descripcion === date && row.fecha_vencimiento === date);
    await r.markGastoProgramadoPaid(current.id);
    assert.equal((await r.listGastosProgramados("pendiente")).find((row) => row.descripcion === date).fecha_vencimiento, expected);
  }
  await r.createGastoProgramado(scheduled);
  await r.createGastoProgramado({ ...scheduled, fecha_vencimiento: "2026-11-30", frecuencia: "anual" });
  const current = (await r.listGastosProgramados()).find((row) => row.descripcion === "Seguro" && row.fecha_vencimiento === scheduled.fecha_vencimiento);
  assert.equal((await r.markGastoProgramadoPaid(current.id)).generated_next, false);
  assert.equal((await r.listGastosProgramados("pendiente")).filter((r) => r.descripcion === "Seguro").length, 1);
  await r.createGastoProgramado({ ...scheduled, descripcion: "Boundary", fecha_vencimiento: "9999-12-31" });
  const boundary = (await r.listGastosProgramados()).find((r) => r.descripcion === "Boundary");
  const count = state.databases[0].prepare("SELECT COUNT(*) AS n FROM movimientos").get().n;
  await assert.rejects(r.markGastoProgramadoPaid(boundary.id));
  assert.equal(state.databases[0].prepare("SELECT COUNT(*) AS n FROM movimientos").get().n, count);
  assert.equal((await r.listGastosProgramados()).find((r) => r.id === boundary.id).estado, "pendiente");
});

test("scheduling projections retain desktop today-window and due-month semantics", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  await r.createCategoria({ nombre: "Seguro", tipo: "gasto" });
  const today = getLocalDateInputValue(), [year,month,day] = today.split("-").map(Number);
  const dateAt = (delta) => getLocalDateInputValue(localCalendarDate(year,month,day+delta));
  for (const [date, amount, status] of [[dateAt(-1), 10, "pendiente"], [today,20,"pendiente"], [dateAt(30),30,"pendiente"], [dateAt(31),40,"pendiente"], [today,50,"pagado"], [today,60,"cancelado"]]) await r.createGastoProgramado({ ...scheduled, fecha_vencimiento: date, monto_estimado: amount, estado: status });
  assert.equal((await r.listGastosProgramados("pendiente",30)).length, 2);
  await r.createMovimiento({ ...movement, fecha: today, monto: 1000 });
  await r.createMovimiento({ ...movement, fecha: today, tipo: "gasto", monto: 100 });
  await r.createMovimiento({ ...movement, fecha: today, tipo: "ahorro", monto: 200 });
  const projection = await r.getSchedulingSummary({ year,month });
  assert.equal(projection.total_pendiente_30_dias,50); assert.equal(projection.total_vencido,10); assert.equal(projection.total_pagado_mes,50);
  const dueThisMonth = (await r.listGastosProgramados("pendiente")).filter((row) => row.fecha_vencimiento.slice(0,7) === today.slice(0,7)).reduce((sum,row)=>sum+row.monto_estimado,0);
  assert.equal(projection.balance_proyectado_mes,900-dueThisMonth);
  assert.equal((await r.getSummary({ year,month })).saldo,700);
  await r.deleteGastoProgramado(2); assert.equal((await r.getSchedulingSummary({year,month})).total_pendiente_30_dias,30);
});

test("scheduling rejects invalid inputs, foreign owners, deleted records and unsafe relationships", async (t) => {
  const state = fixture(t), r = state.modules().mobileFinanceRepository;
  for (const patch of [{ descripcion:" " },{ descripcion:"x".repeat(501) },{ monto_estimado:0 },{ categoria_id:-1 },{ fecha_vencimiento:"2026-02-29" },{ estado:"bad" },{ es_recurrente:2 },{ frecuencia:"diaria" }]) await assert.rejects(r.createGastoProgramado({...scheduled,...patch}));
  assert.equal(state.loads,0);
  await r.createCategoria({nombre:"Seguro",tipo:"gasto"}); await r.createGastoProgramado(scheduled);
  const raw=state.databases[0]; raw.exec("INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Other','gasto','other','other-cat')");
  raw.exec("INSERT INTO gastos_programados(descripcion,categoria_id,monto_estimado,fecha_vencimiento,owner_user_id,sync_id) VALUES('Other',2,1,'2026-10-04','other','other-schedule')");
  await assert.rejects(r.markGastoProgramadoPaid(2)); await assert.rejects(r.updateGastoProgramado(2,scheduled)); await assert.rejects(r.deleteGastoProgramado(2));
  assert.throws(()=>raw.exec("INSERT INTO gastos_programados(descripcion,categoria_id,monto_estimado,fecha_vencimiento,sync_id) VALUES('Cross',2,1,'2026-10-04','cross')"), /FOREIGN KEY/);
  await r.deleteCategoria(1); assert.deepEqual(await r.listGastosProgramados(),[]); await assert.rejects(r.markGastoProgramadoPaid(1));
  assert.ok(raw.prepare("SELECT deleted_at FROM gastos_programados WHERE id=1").get().deleted_at);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(),[]);
});

test("calendar uses actual active movements only, groups days and preserves desktop investment totals", async (t) => {
  t.mock.method(require("../lib/date.ts"), "getLocalDateInputValue", () => "2026-10-04");
  const state=fixture(t),r=state.modules().mobileFinanceRepository;
  await r.createCategoria({nombre:"Seguro",tipo:"gasto"}); await r.createCategoria({nombre:"Inversiones legacy",tipo:"gasto"});
  await r.createGastoProgramado(scheduled); await r.createGastoFijo(fixed); await r.createMeta(goal);
  await r.createMovimiento({...movement,monto:500}); await r.createMovimiento({...movement,tipo:"gasto",monto:100});
  await r.createMovimiento({...movement,tipo:"gasto",categoria_id:2,monto:20}); await r.createMovimiento({...movement,fecha:"2026-10-05",tipo:"ahorro",monto:50});
  await r.createMovimiento({...movement,monto:999}); await r.deleteMovimiento(5);
  let days=await r.getCalendar(period); assert.equal(days.length,2); assert.deepEqual(days[0].movimientos.map(r=>r.id),[1,2,3]);
  assert.deepEqual(days[0].totales,{ingreso:500,gasto:100,ahorro:0,inversion:20}); assert.equal(days[0].movimientos[2].tipo,"gasto");
  assert.deepEqual(await r.getCalendar({year:2027,month:1}),[]);
  await r.markGastoProgramadoPaid(1); days=await r.getCalendar(period);
  assert.equal(days.reduce((n,d)=>n+d.movimientos.length,0),5);
  assert.deepEqual(state.desktopCalls,[]);
});

test("calendar grid starts Monday with 42 cells and correct local dates across month/year boundaries", (t) => {
  const previous=process.env.TZ; process.env.TZ="America/Argentina/Buenos_Aires"; t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  for(const [year,month,total] of [[2026,2,28],[2028,2,29],[2026,12,31],[2027,1,31]]) {
    const cells=calendarGrid({year,month}); assert.equal(cells.length,42); assert.equal(cells.filter(c=>c.inMonth).length,total);
    const [y,m,d]=cells[0].iso.split("-").map(Number); assert.equal(localCalendarDate(y,m,d).getDay(),1);
  }
  assert.deepEqual(adjacentPeriod({year:2026,month:12},1),{year:2027,month:1});
  assert.deepEqual(adjacentPeriod({year:2027,month:1},-1),{year:2026,month:12});
  assert.equal(calendarGrid({year:2028,month:2},"2028-02-29").find(c=>c.isToday).iso,"2028-02-29");
});

test("v2 to v3 migration preserves every field of all five existing tables and balances", async (t) => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"scisonomics-v3-upgrade-")), filename=path.join(temp,"mobile.db"),raw=new DatabaseSync(filename);
  raw.exec(schema);raw.exec(planningSchema);raw.exec("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER); INSERT INTO _sqlx_migrations VALUES(1,1),(2,1)");
  raw.exec("INSERT INTO categorias(nombre,tipo,sync_id) VALUES('V2','gasto','cat-v2'); INSERT INTO movimientos(fecha,tipo,categoria_id,monto,sync_id) VALUES('2026-10-04','ingreso',1,700,'move-v2')");
  raw.exec("INSERT INTO gastos_fijos(categoria_id,descripcion,monto,dia_vencimiento,sync_id,deleted_at) VALUES(1,'V2',10,31,'fixed-v2','2026-10-03'); INSERT INTO presupuestos(categoria_id,mes,anio,monto,sync_id) VALUES(1,10,2026,100,'budget-v2'); INSERT INTO metas_ahorro(nombre,monto_objetivo,sync_id) VALUES('V2',100,'goal-v2')");
  const tables=["categorias","movimientos","gastos_fijos","presupuestos","metas_ahorro"], baseline=Object.fromEntries(tables.map(name=>[name,raw.prepare(`SELECT * FROM ${name}`).all()]));raw.close();
  const state=fixture(t,filename);t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));const m=state.modules();await m.getMobileDatabase();
  for(const name of tables)assert.deepEqual(state.databases[0].prepare(`SELECT * FROM ${name}`).all().map(row=>{
    if(name==='categorias'||name==='movimientos') {assert.equal(row.last_remote_updated_at,null);assert.equal(row.last_remote_device_id,null);}
    return Object.fromEntries(Object.keys(baseline[name][0]).map(key=>[key,row[key]]));
  }),baseline[name].map(row=>({...row})));
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo,700);assert.deepEqual(state.databases[0].prepare("PRAGMA foreign_key_check").all(),[]);
});

test("desktop scheduling and calendar adapters preserve the existing HTTP API", async (t) => {
  const state=fixture(t),m=state.modules();global.window.navigator.userAgent="Windows NT";const r=await m.getFinanceRepository();
  await r.listGastosProgramados("pendiente",30);await r.createGastoProgramado(scheduled);await r.updateGastoProgramado(1,scheduled);await r.deleteGastoProgramado(1);await r.markGastoProgramadoPaid(1);await r.getSchedulingSummary(period);await r.getCalendar(period);
  assert.deepEqual(state.desktopCalls.map(c=>c.name),["gastosProgramados","createGastoProgramado","updateGastoProgramado","deleteGastoProgramado","marcarPagado","stats","calendario"]);
  assert.deepEqual(state.desktopCalls[0].args,["pendiente",30]);assert.deepEqual(state.desktopCalls[6].args,[10,2026]);assert.equal(state.loads,0);
});

const { categoryShares, sixMonthPeriods, periodStart, periodEnd } = require("../services/data/financeAnalytics.ts");

test("statistics aggregate actual types and twelve months without mixing opening balance or plans", async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;
  await r.createCategoria({nombre:"General",tipo:"gasto"});
  for(const [tipo,monto] of [["ingreso",1000.15],["gasto",300.05],["ahorro",50.10],["inversion",20]])await r.createMovimiento({...movement,tipo,monto});
  await r.createMovimiento({...movement,fecha:"2025-12-31",monto:700});
  await r.createMovimiento({...movement,fecha:"2027-01-01",monto:999});
  await r.createGastoProgramado({...scheduled,monto_estimado:100});
  const stats=await r.getStatistics(period);
  assert.deepEqual(stats.month_totals,{ingreso:1000.15,gasto:300.05,ahorro:50.10,inversion:20,balance:700.10,disponible_luego_ahorro:650});
  assert.equal(stats.summary.saldo_inicial,700);assert.equal(stats.summary.balance_final,1400.10);
  assert.equal((await r.getSummary(period)).saldo,1330);
  assert.equal(stats.planificacion.balance_proyectado_mes,600.10);
  assert.equal(stats.trend.length,12);assert.deepEqual(stats.trend[9],{mes:10,ingresos:1000.15,gastos:300.05});
  assert.deepEqual(stats.trend[0],{mes:1,ingresos:0,gastos:0});assert.equal(state.desktopCalls.length,0);
});

test("expense categories use active same-owner references, counts, order and safe percentages",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;
  for(const nombre of ['Mayor','Menor','Eliminada'])await r.createCategoria({nombre,tipo:'gasto'});
  for(const [categoria_id,monto] of [[1,100],[1,25],[2,75],[3,500],[2,999]])await r.createMovimiento({...movement,tipo:'gasto',categoria_id,monto});
  await r.deleteMovimiento(5);const db=state.databases[0];
  db.exec("UPDATE categorias SET deleted_at='2026-10-03' WHERE id=3; INSERT INTO categorias(nombre,tipo,owner_user_id,sync_id) VALUES('Otro','gasto','otro','otro-cat'); INSERT INTO movimientos(fecha,tipo,categoria_id,monto,owner_user_id,sync_id) VALUES('2026-10-04','gasto',4,10000,'otro','otro-mov')");
  const stats=await r.getStatistics(period);assert.deepEqual(stats.expenses_by_category.map(c=>[c.categoria,c.total,c.movimientos]),[['Mayor',125,2],['Menor',75,1]]);
  assert.deepEqual(categoryShares(stats.expenses_by_category).map(c=>c.percent),[62.5,37.5]);
  assert.deepEqual(categoryShares([{categoria:'Cero',total:0}]).map(c=>c.percent),[0]);assert.deepEqual(categoryShares([]),[]);
  assert.equal((await r.getAnnualStatistics(2026)).gastos_por_categoria.length,2);
});

test("monthly report retains desktop investment category rule while statistics/annual use type",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;
  await r.createCategoria({nombre:'General',tipo:'inversion'});await r.createCategoria({nombre:'Inversiones',tipo:'gasto'});
  await r.createMovimiento({...movement,tipo:'inversion',monto:100});
  await r.createMovimiento({...movement,tipo:'gasto',categoria_id:2,monto:30});
  await r.createMovimiento({...movement,tipo:'ingreso',categoria_id:2,monto:20});
  assert.equal((await r.getStatistics(period)).month_totals.inversion,100);
  const report=await r.getMonthlyReport(period);assert.equal(report.inversiones,50);assert.equal(report.balance_operativo,-10);assert.equal(report.disponible_luego_ahorro,-10);
  assert.equal((await r.getAnnualStatistics(2026)).totals.balance,-110);
});

test("monthly report has six consecutive real periods across December/January and deterministic top five",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;await r.createCategoria({nombre:'General',tipo:'gasto'});
  await r.createMovimiento({...movement,fecha:'2026-07-01',monto:999});await r.createMovimiento({...movement,fecha:'2026-12-31',monto:700});
  await r.createMovimiento({...movement,fecha:'2027-01-01',monto:100});
  for(let i=1;i<=7;i++)await r.createMovimiento({...movement,fecha:`2027-01-${String(i).padStart(2,'0')}`,tipo:'gasto',monto:i*10,descripcion:`Gasto ${i}`});
  const report=await r.getMonthlyReport({year:2027,month:1});
  assert.deepEqual(report.evolucion_ultimos_6_meses.map(r=>[r.anio,r.mes]),[[2026,8],[2026,9],[2026,10],[2026,11],[2026,12],[2027,1]]);
  assert.equal(report.evolucion_ultimos_6_meses[0].ingreso,0);assert.equal(report.evolucion_ultimos_6_meses[4].ingreso,700);
  assert.equal(report.ingresos,100);assert.equal(report.gastos,280);assert.equal(report.balance_operativo,-180);
  assert.deepEqual(report.top_movimientos.map(r=>r.monto),[70,60,50,40,30]);assert.equal(report.top_categorias[0].total,280);
  assert.equal((await r.getSummary({year:2027,month:1})).saldo,1519);
  assert.equal(periodEnd({year:2026,month:12}),'2027-01-01');assert.equal(periodStart({year:2028,month:2}),'2028-02-01');
  assert.deepEqual(sixMonthPeriods({year:2027,month:1}),report.evolucion_ultimos_6_meses.map(r=>({year:r.anio,month:r.mes})));
});

test("report includes only exceeded budgets and active goals; initial goals/plans/fixed templates never become real totals",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;await r.createCategoria({nombre:'Servicios',tipo:'gasto'});
  await r.createPresupuesto({categoria_id:1,mes:10,anio:2026,monto:100});await r.createMeta({...goal,monto_inicial:500});await r.createMeta({...goal,nombre:'Pausada',estado:'pausada'});
  await r.createGastoFijo(fixed);await r.createGastoProgramado({...scheduled,monto_estimado:50});
  await r.createMovimiento({...movement,monto:1000});await r.createMovimiento({...movement,tipo:'gasto',monto:100});await r.createMovimiento({...movement,tipo:'ahorro',meta_id:1,monto:50});
  let report=await r.getMonthlyReport(period);assert.equal(report.balance_operativo,900);assert.equal(report.disponible_luego_ahorro,850);
  assert.equal(report.presupuestos_excedidos.length,0);assert.equal(report.metas.length,1);assert.equal(report.metas[0].monto_ahorrado,550);
  await r.markGastoProgramadoPaid(1);report=await r.getMonthlyReport(period);
  assert.equal(report.gastos,150);assert.equal(report.presupuestos_excedidos[0].monto_gastado,150);assert.equal(report.balance_operativo,850);
  assert.equal((await r.getAnnualStatistics(2026)).totals.balance,800);
  await r.deleteMeta(1);assert.equal((await r.getMonthlyReport(period)).metas.length,0);assert.equal((await r.getStatistics(period)).month_totals.ahorro,50);
});

test("empty and single-type years stay finite, average over twelve months and tie maxima use first month",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;await r.createCategoria({nombre:'Sólo ahorro',tipo:'ahorro'});
  const empty=await r.getAnnualStatistics(2026);assert.equal(empty.monthly.length,12);assert.equal(empty.totals.movimientos,0);assert.equal(empty.mes_mayor_gasto.mes,1);
  assert.equal((await r.getMonthlyReport(period)).evolucion_ultimos_6_meses.length,6);
  await r.createMovimiento({...movement,tipo:'ahorro',monto:12});let annual=await r.getAnnualStatistics(2026);assert.equal(annual.totals.balance,-12);assert.equal(annual.promedios_mensuales.balance,-1);
  const stats=await r.getStatistics(period);assert.equal(stats.month_totals.balance,0);assert.equal(stats.month_totals.disponible_luego_ahorro,-12);assert.equal(stats.expenses_by_category.length,0);
  await r.createMovimiento({...movement,fecha:'2026-01-01',monto:120});await r.createMovimiento({...movement,fecha:'2026-12-01',monto:120});
  annual=await r.getAnnualStatistics(2026);assert.equal(annual.mes_mayor_ingreso.mes,1);assert.equal(annual.promedios_mensuales.ingresos,20);
  assert(Object.values(annual.promedios_mensuales).every(Number.isFinite));assert.equal(annual.categoria_mayor_gasto,null);
});

test("analytics are read-only and reuse existing owner/date index instead of loading the whole ledger",async(t)=>{
  const state=fixture(t),m=state.modules(),r=m.mobileFinanceRepository;await r.createCategoria({nombre:'Local',tipo:'ingreso'});await r.createMovimiento(movement);
  const db=state.databases[0],before=JSON.stringify(db.prepare('SELECT * FROM movimientos').all()),start=state.statements.length;
  await r.getStatistics(period);await r.getMonthlyReport(period);await r.getAnnualStatistics(2026);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM movimientos').all()),before);
  assert(state.statements.slice(start).every(s=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(s.sql)));
  const queries=state.statements.slice(start).filter(s=>s.sql.includes('GROUP BY substr(m.fecha,1,7)'));assert(queries.length>=3);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+queries[0].sql.replace(/\$\d+/g,'?')).all('local','2026-01-01','2027-01-01');assert(plan.some(p=>p.detail.includes('idx_movimientos_owner_fecha')));
});

test("analytics reject invalid periods before database access and sanitize native read failures",async(t)=>{
  const state=fixture(t),r=state.modules().mobileFinanceRepository;
  await assert.rejects(r.getStatistics({year:2026,month:13}),/mes y año/);await assert.rejects(r.getMonthlyReport({year:0,month:1}),/mes y año/);await assert.rejects(r.getAnnualStatistics(NaN),/mes y año/);assert.equal(state.loads,0);
  await r.listCategorias();state.failReads=true;
  for(const read of [()=>r.getStatistics(period),()=>r.getMonthlyReport(period),()=>r.getAnnualStatistics(2026)])await assert.rejects(read(),e=>!e.message.includes('private')&&!e.message.includes('SELECT')&&!e.message.includes('secret'));
});

test("derived statistics and reports remain identical after reopening persisted SQLite",async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scisonomics-analytics-')),state=fixture(t,path.join(dir,'mobile.db'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let m=state.modules(),r=m.mobileFinanceRepository;await r.createCategoria({nombre:'Local',tipo:'ingreso'});await r.createMovimiento(movement);
  const before=[await r.getStatistics(period),await r.getMonthlyReport(period),await r.getAnnualStatistics(2026)];await (await m.getMobileDatabase()).close();m=state.modules();r=m.mobileFinanceRepository;
  assert.deepEqual([await r.getStatistics(period),await r.getMonthlyReport(period),await r.getAnnualStatistics(2026)],before);
  assert.deepEqual(state.databases[0].prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(state.databases[0].prepare('SELECT COUNT(*) AS n FROM _sqlx_migrations').get().n,5);
});

test("desktop analytics delegate exact existing API periods and never open mobile SQLite",async(t)=>{
  const state=fixture(t),m=state.modules();global.window.navigator.userAgent='Windows NT';const r=await m.getFinanceRepository();
  await r.getStatistics(period);await r.getMonthlyReport(period);await r.getAnnualStatistics(2026);
  assert.deepEqual(state.desktopCalls,[{name:'stats',args:[10,2026]},{name:'reporteMensual',args:[10,2026]},{name:'statsAnual',args:[2026]}]);assert.equal(state.loads,0);
});

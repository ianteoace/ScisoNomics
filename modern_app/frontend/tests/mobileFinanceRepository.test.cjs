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
const driverPath = require.resolve("@tauri-apps/plugin-sql");
const apiPath = path.join(root, "services/api.ts");
const movement = { fecha: "2026-10-04", tipo: "ingreso", categoria_id: 1, descripcion: "Ingreso demo", monto: 10000 };
const period = { year: 2026, month: 10 };

function fixture(t, filename = ":memory:") {
  const previousWindow = global.window;
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
      if (state.disableFK) raw.exec("PRAGMA foreign_keys = OFF");
      if (state.omitMigration) raw.exec("DELETE FROM _sqlx_migrations");
      if (state.omitPlanningMigration) raw.exec("DELETE FROM _sqlx_migrations WHERE version=2");
      state.databases.push(raw);
      return {
        select: async (sql, params = []) => { state.statements.push({ sql, params }); const { statement, values } = bind(raw, sql, params); return statement.all(...values); },
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
  const api = Object.fromEntries(["categorias", "createCategoria", "updateCategoria", "deleteCategoria", "movimientos", "createMovimiento", "updateMovimiento", "deleteMovimiento", "gastosFijos", "createGastoFijo", "updateGastoFijo", "deleteGastoFijo", "presupuestos", "upsertPresupuesto", "deletePresupuesto", "metas", "createMeta", "updateMeta", "deleteMeta"].map((name) => [name, async (...args) => {
    state.desktopCalls.push({ name, args });
    return name === "categorias" ? [{ id: 41, nombre: "Desktop", tipo: "gasto" }] : name === "movimientos" ? { rows: [{ ...movement, id: 42, categoria: "Desktop", saldo_acumulado: 10000 }], summary: { saldo_inicial: 700 } } : { ok: true };
  }]));
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { api } };
  function modules() {
    for (const cached of Object.keys(require.cache)) if (cached.startsWith(path.join(root, "services/data"))) delete require.cache[cached];
    return { ...require("../services/data/mobileDatabase.ts"), ...require("../services/data/mobileFinanceRepository.ts"), ...require("../services/data/financeRepository.ts"), ...require("../services/data/financeSummary.ts") };
  }
  t.after(() => {
    for (const db of state.databases) db.close();
    global.window = previousWindow;
    if (previousDriver) require.cache[driverPath] = previousDriver; else delete require.cache[driverPath];
    if (previousApi) require.cache[apiPath] = previousApi; else delete require.cache[apiPath];
  });
  return Object.assign(state, { modules });
}

test("repository contract selects mobile without any desktop API calls", async (t) => {
  const state = fixture(t), m = state.modules();
  const repository = await m.getFinanceRepository();
  assert.equal(repository, m.mobileFinanceRepository);
  assert.deepEqual(Object.keys(repository).sort(), ["createCategoria", "createMovimiento", "deleteCategoria", "deleteMovimiento", "getSummary", "listCategorias", "listMovimientos", "updateCategoria", "updateMovimiento", "listGastosFijos", "createGastoFijo", "updateGastoFijo", "deleteGastoFijo", "listPresupuestos", "createPresupuesto", "updatePresupuesto", "deletePresupuesto", "listMetas", "createMeta", "updateMeta", "deleteMeta"].sort());
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
  for (const flag of ["failLoads", "disableFK", "omitMigration", "omitPlanningMigration"]) {
    state[flag] = true;
    await assert.rejects(m.getMobileDatabase(), (error) => {
      assert.match(error.message, /almacenamiento local/); assert.doesNotMatch(error.message, /private|SELECT/); return true;
    });
    state[flag] = false;
  }
  await m.getMobileDatabase(); assert.equal(state.loads, 5);
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
  assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%' ORDER BY name").all().map((r) => r.name), ["categorias", "gastos_fijos", "metas_ahorro", "movimientos", "presupuestos"]);
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
  assert.deepEqual(upgraded.prepare("SELECT * FROM categorias").all(), categories);
  assert.deepEqual(upgraded.prepare("SELECT * FROM movimientos ORDER BY id").all().map(({ meta_id, ...r }) => { assert.equal(meta_id, null); return r; }), movements);
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo, 700);
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  await (await m.getMobileDatabase()).close(); m = state.modules(); await m.getMobileDatabase();
  assert.equal((await m.mobileFinanceRepository.getSummary(period)).saldo, 700);
  assert.deepEqual(state.databases[0].prepare("SELECT version,success FROM _sqlx_migrations ORDER BY version").all().map((r) => ({ ...r })), [{ version: 1, success: 1 }, { version: 2, success: 1 }]);
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

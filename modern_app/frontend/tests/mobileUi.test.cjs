const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText, filename);
};
require.extensions[".css"] = (module) => { module.exports = { dialog: "dialog", drawer: "drawer" }; };
function stub(filename, exports) {
  const resolved = filename.startsWith(".") ? path.resolve(root, filename) : require.resolve(filename);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
let pathname = "/dashboard";
const router = { replace: (href) => { pathname = href; } };
stub("next/navigation", { usePathname: () => pathname, useRouter: () => router });
stub("next/link", { __esModule: true, default: ({ href, onClick, prefetch, children, ...props }) => React.createElement("a", {
  ...props, href, onClick: () => { onClick?.(); pathname = href; },
}, children) });
const summary = { ingresos: 10000, gastos: 2500, ahorros: 200, inversiones: 300, saldoInicial: 700, saldo: 7700, balance: 7500 };
const finance = { period: "2026-10", data: { categories: [{ id: 1, nombre: "Ingreso Mobile", tipo: "ingreso" }], movements: [], summary, fixedExpenses: [], budgets: [], goals: [] },
  loading: false, busy: false, error: "", notice: "", setPeriod() {}, clearMessages() {}, reload() {}, mutate: async () => true };
stub("./components/mobile/useMobileFinance.ts", { useMobileFinance: () => finance });
const { MobileApp } = require("../components/mobile/MobileApp.tsx");
const { MobileDialog } = require("../components/mobile/MobileDialog.tsx");
const { MobileMovementForm } = require("../components/mobile/movimientos/MobileMovementForm.tsx");
const { compatibleCategories, formatMobileDate } = require("../components/mobile/mobileUi.ts");
const { getLocalDateInputValue } = require("../lib/date.ts");

function renderer(t, Component, props = {}, nativeRefs = true) {
  const slots = new Map(); let current, pending = [], shown = 0, closed = 0, restored = 0;
  const oldDocument = global.document;
  global.document = { body: { style: { overflow: "scroll" } },
    activeElement: { isConnected: true, focus: () => { restored++; } }, getElementById: () => ({ focus: () => { restored++; } }) };
  t.mock.method(React, "useState", (initial) => {
    const instance = current, index = instance.cursor++;
    if (!(index in instance.values)) instance.values[index] = typeof initial === "function" ? initial() : initial;
    return [instance.values[index], (value) => { instance.values[index] = typeof value === "function" ? value(instance.values[index]) : value; }];
  });
  t.mock.method(React, "useRef", (initial) => {
    if (nativeRefs) return { current: { showModal: () => { shown++; }, close: () => { closed++; } } };
    const instance = current, index = instance.cursor++;
    if (!(index in instance.values)) instance.values[index] = { current: initial };
    return instance.values[index];
  });
  t.mock.method(React, "useId", () => "dialog-title");
  t.mock.method(React, "useEffect", (callback, deps) => {
    const instance = current, index = instance.cursor++, previous = instance.values[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => {
      previous?.cleanup?.(); instance.values[index] = { deps, cleanup: callback() };
    });
  });
  function resolve(node, key) {
    if (Array.isArray(node)) return node.map((child, i) => resolve(React.isValidElement(child) ? React.cloneElement(child, { key: child.key ?? i }) : child, `${key}.${i}`));
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === "function") {
      const instanceKey = `${key}:${node.type.name}`;
      if (!slots.has(instanceKey)) slots.set(instanceKey, { values: [], cursor: 0 });
      current = slots.get(instanceKey); current.cursor = 0;
      const resolved = resolve(node.type(node.props), `${instanceKey}.render`);
      return React.isValidElement(resolved) && node.key != null ? React.cloneElement(resolved, { key: node.key }) : resolved;
    }
    return React.cloneElement(node, {}, resolve(node.props.children, `${key}.children`));
  }
  const tree = () => resolve(React.createElement(Component, props), "root");
  function all(node, predicate) {
    if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
    if (!React.isValidElement(node)) return [];
    return [...(predicate(node) ? [node] : []), ...all(node.props.children, predicate)];
  }
  function dispose() { for (const instance of slots.values()) for (const value of instance.values) { value?.cleanup?.(); if (value?.cleanup) value.cleanup = undefined; } }
  t.after(() => { dispose(); global.document = oldDocument; });
  return { tree, html: () => renderToStaticMarkup(tree()), find: (predicate) => all(tree(), predicate),
    effects: () => { const callbacks = pending; pending = []; callbacks.forEach((callback) => callback()); },
    dispose, counts: () => ({ shown, closed, restored }) };
}

for (const [href, title, visible, hidden] of [
  ["/dashboard", "Inicio", /Resumen financiero/, /Listado de categorías|Listado de movimientos/],
  ["/movimientos", "Movimientos", /Listado de movimientos/, /Resumen financiero|Listado de categorías/],
  ["/categorias", "Categorías", /Listado de categorías/, /Resumen financiero|Listado de movimientos/],
  ["/gastos-fijos", "Gastos fijos", /Listado de gastos fijos/, /Listado de presupuestos|Listado de metas|Resumen financiero/],
  ["/presupuestos", "Presupuestos", /Listado de presupuestos/, /Listado de gastos fijos|Listado de metas|Resumen financiero/],
  ["/metas", "Metas", /Listado de metas/, /Listado de presupuestos|Listado de gastos fijos|Resumen financiero/],
]) test(`mobile route ${href} renders only ${title}`, (t) => {
  pathname = href; const view = renderer(t, MobileApp);
  assert.match(view.html(), visible); assert.doesNotMatch(view.html(), hidden);
  assert.match(view.html(), new RegExp(`<h1[^>]*>${title}</h1>`));
  assert.equal(view.find((node) => node.type === "dialog").length, 0);
});

test("hamburger opens drawer with desktop-consistent links; X closes it", (t) => {
  pathname = "/dashboard"; const view = renderer(t, MobileApp);
  view.find((node) => node.props["aria-label"] === "Abrir menú")[0].props.onClick({ currentTarget: { focus() {} } });
  const html = view.html();
  assert.match(html, /<dialog/); assert.match(html, /aria-modal="true"/); assert.match(html, /aria-labelledby="dialog-title"/);
  assert.match(html, /aria-expanded="true"/); assert.match(html, /aria-current="page"/);
  assert.deepEqual(view.find((node) => node.type === "a").map((node) => node.props.href), ["/dashboard", "/movimientos", "/categorias", "/gastos-fijos", "/presupuestos", "/metas"]);
  view.find((node) => node.props["aria-label"] === "Cerrar")[0].props.onClick({ currentTarget: { focus() {} } });
  assert.doesNotMatch(view.html(), /<dialog/);
});

for (const href of ["/dashboard", "/movimientos", "/categorias", "/gastos-fijos", "/presupuestos", "/metas"]) test(`drawer navigates to ${href} and closes automatically`, (t) => {
  pathname = "/dashboard"; const view = renderer(t, MobileApp);
  view.find((node) => node.props["aria-label"] === "Abrir menú")[0].props.onClick({ currentTarget: { focus() {} } });
  view.find((node) => node.type === "a" && node.props.href === href)[0].props.onClick({ currentTarget: { focus() {} } });
  assert.equal(pathname, href); assert.doesNotMatch(view.html(), /<dialog/);
});

test("drawer closes on outside touch and Escape, uses native focus isolation and restores scroll", (t) => {
  let dismissed = 0; const view = renderer(t, MobileDialog, { title: "Menú", drawer: true, onClose: () => { dismissed++; }, children: "Secciones" });
  const node = view.find((node) => node.type === "dialog")[0];
  view.effects(); assert.equal(view.counts().shown, 1); assert.equal(document.body.style.overflow, "hidden");
  const target = {}; node.props.onClick({ target, currentTarget: target }); assert.equal(dismissed, 1);
  node.props.onClick({ target: {}, currentTarget: target }); assert.equal(dismissed, 1);
  let prevented = false; node.props.onCancel({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(dismissed, 2);
  view.dispose(); assert.equal(view.counts().closed, 1); assert.equal(view.counts().restored, 1); assert.equal(document.body.style.overflow, "scroll");
});

test("pending mutation prevents dialog dismissal", (t) => {
  let dismissed = false; const view = renderer(t, MobileDialog, { title: "Guardar", busy: true, onClose: () => { dismissed = true; } });
  const node = view.find((node) => node.type === "dialog")[0], target = {};
  node.props.onCancel({ preventDefault() {} }); node.props.onClick({ target, currentTarget: target });
  assert.equal(dismissed, false); assert.equal(view.find((node) => node.props["aria-label"] === "Cerrar")[0].props.disabled, true);
});

test("unsupported mobile routes redirect to dashboard without rendering desktop content", (t) => {
  pathname = "/configuracion"; const view = renderer(t, MobileApp);
  assert.doesNotMatch(view.html(), /Resumen financiero|Listado de movimientos|Listado de categorías/);
  view.effects(); assert.equal(pathname, "/dashboard"); assert.match(view.html(), /Resumen financiero/);
});

test("movement form edits category by ID and submits validated values, note and local date", async (t) => {
  let saved;
  const row = { id: 7, fecha: "2026-01-01", tipo: "gasto", categoria: "Gasto Mobile", categoria_id: 2, descripcion: "Gasto", monto: 3000, nota: "Detalle", saldo_acumulado: 7000 };
  const view = renderer(t, MobileMovementForm, { categories: [{ id: 2, nombre: "Gasto Mobile", tipo: "gasto" }], movement: row, busy: false, error: "", onClose() {}, onSave: async (input) => { saved = input; return true; } });
  await view.find((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, { fecha: "2026-01-01", tipo: "gasto", categoria_id: 2, descripcion: "Gasto", monto: 3000, nota: "Detalle", meta_id: null });
  assert.match(view.html(), /inputMode="decimal"/);
});

test("mobile dates and compatible categories follow desktop choices without UTC date parsing", () => {
  assert.equal(getLocalDateInputValue(new Date(2026, 0, 1, 0, 5)), "2026-01-01");
  assert.equal(formatMobileDate("2026-01-01"), "1/1/2026");
  const categories = [{ id: 1, nombre: "Ingreso", tipo: "ingreso" }, { id: 2, nombre: "Gastos", tipo: "gasto" }, { id: 3, nombre: "Ahorro legacy", tipo: "gasto" }];
  assert.deepEqual(compatibleCategories(categories, "gasto").map((row) => row.id), [2, 3]);
  assert.deepEqual(compatibleCategories(categories, "ahorro").map((row) => row.id), [3]);
});

test("first installation shows empty dashboard and category guidance without creating data", (t) => {
  const previous = finance.data;
  finance.data = { ...previous, categories: [], movements: [], summary: { ingresos: 0, gastos: 0, ahorros: 0, inversiones: 0, saldoInicial: 0, saldo: 0, balance: 0 } };
  t.after(() => { finance.data = previous; });
  pathname = "/dashboard"; const view = renderer(t, MobileApp);
  assert.match(view.html(), /No tenés movimientos este mes/);
  pathname = "/categorias";
  assert.match(view.html(), /Creá una categoría para empezar/);
});

function financeHook(t, repository) {
  const hookPath = path.join(root, "components/mobile/useMobileFinance.ts"), repoPath = path.join(root, "services/data/financeRepository.ts");
  const oldHook = require.cache[hookPath], oldRepo = require.cache[repoPath];
  stub("./services/data/financeRepository.ts", { getFinanceRepository: async () => repository });
  delete require.cache[hookPath];
  const { useMobileFinance } = require(hookPath);
  t.after(() => { require.cache[hookPath] = oldHook; if (oldRepo) require.cache[repoPath] = oldRepo; else delete require.cache[repoPath]; });
  let value;
  function Probe() { value = useMobileFinance(); return React.createElement("div"); }
  const view = renderer(t, Probe, {}, false);
  return { ...view, value: () => value };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("mobile reload ignores stale periods and does not poll on navigation/render", async (t) => {
  const first = deferred(); let reads = 0;
  const repository = { listGastosFijos: async () => [], listPresupuestos: async () => [], listMetas: async () => [], listCategorias: async () => [], listMovimientos: async () => [], getSummary: async () => { reads++; return reads === 1 ? first.promise : { ...summary, saldo: 222 }; } };
  const view = financeHook(t, repository);
  view.html(); view.effects(); await flush();
  assert.equal(view.value().period, getLocalDateInputValue().slice(0, 7));
  view.value().setPeriod("2026-01"); view.html(); view.effects(); await flush(); view.html();
  assert.equal(view.value().data.summary.saldo, 222);
  first.resolve({ ...summary, saldo: 999 }); await flush(); view.html();
  assert.equal(view.value().data.summary.saldo, 222);
  view.html(); view.effects(); await flush(); assert.equal(reads, 2);
});

test("mobile mutations prevent duplicate writes and refresh once after success", async (t) => {
  let writes = 0, reads = 0; const write = deferred();
  const repository = { listGastosFijos: async () => [], listPresupuestos: async () => [], listMetas: async () => [], listCategorias: async () => [], listMovimientos: async () => [], getSummary: async () => { reads++; return summary; } };
  const view = financeHook(t, repository);
  view.html(); view.effects(); await flush(); view.html();
  const operation = async () => { writes++; await write.promise; };
  const pending = view.value().mutate(operation, "Guardado");
  assert.equal(await view.value().mutate(operation, "Duplicado"), false);
  await flush(); assert.equal(writes, 1);
  write.resolve(); assert.equal(await pending, true);
  view.html(); view.effects(); await flush(); view.html(); assert.equal(reads, 2);
  assert.equal(view.value().notice, "Guardado");
});

const { MobileFixedExpenseForm } = require("../components/mobile/gastos-fijos/MobileFixedExpenseForm.tsx");
const { MobileBudgetForm } = require("../components/mobile/presupuestos/MobileBudgetForm.tsx");
const { MobileGoalForm } = require("../components/mobile/metas/MobileGoalForm.tsx");
const { mobileSections } = require("../components/mobile/MobileSidebar.tsx");
const { budgetState, goalState } = require("../components/mobile/MobilePlanningUI.tsx");

test("planning navigation retains desktop Premium feature metadata without enabling billing", () => {
  assert.deepEqual(mobileSections.filter((s) => s.premium).map(({ href, feature }) => ({ href, feature })), [
    { href: "/gastos-fijos", feature: "fixed_expenses" }, { href: "/presupuestos", feature: "budgets" }, { href: "/metas", feature: "saving_goals" },
  ]);
  assert.deepEqual([69, 70, 100, 101].map(budgetState), ["En control", "Cerca del límite", "Al límite", "Superado"]);
  assert.deepEqual([74, 75, 100].map(goalState), ["En progreso", "Cerca de completar", "Cumplida"]);
});

test("fixed expense form submits edited monthly day, amount and active state", async (t) => {
  let saved, closed = 0;
  const row = { id: 1, categoria_id: 2, categoria: "Servicios", descripcion: "Alquiler", monto: 750, dia_vencimiento: 31, activo: 0 };
  const view = renderer(t, MobileFixedExpenseForm, { row, categories: [{ id: 2, nombre: "Servicios", tipo: "gasto" }], busy: false, error: "", onClose: () => { closed++; }, onSave: async (input) => { saved = input; return true; } });
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, { categoria_id: 2, descripcion: "Alquiler", monto: 750, dia_vencimiento: 31, activo: 0 }); assert.equal(closed, 1);
  assert.match(view.html(), /Mensual/); assert.match(view.html(), /inputMode="decimal"/);
});

test("budget editing keeps category and period while changing the limit", async (t) => {
  let saved;
  const row = { id: 1, categoria_id: 2, categoria: "Servicios", mes: 10, anio: 2026, monto_presupuestado: 2000 };
  const view = renderer(t, MobileBudgetForm, { row, rows: [row], categories: [{ id: 2, nombre: "Servicios", tipo: "gasto" }], period: "2026-11", busy: false, error: "", onClose() {}, onSave: async (input) => { saved = input; return true; } });
  assert.equal(view.find((n) => n.type === "select")[0].props.disabled, true);
  assert.equal(view.find((n) => n.props.type === "month")[0].props.disabled, true);
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, { categoria_id: 2, mes: 10, anio: 2026, monto: 2000 });
});

test("goal form submits initial funds, optional date and explicit state", async (t) => {
  let saved;
  const row = { id: 1, nombre: "Viaje", monto_objetivo: 1000, monto_inicial: 250, fecha_objetivo: "2028-02-29", descripcion: "Detalle", estado: "pausada" };
  const view = renderer(t, MobileGoalForm, { row, busy: false, error: "", onClose() {}, onSave: async (input) => { saved = input; return true; } });
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, { nombre: "Viaje", monto_objetivo: 1000, monto_inicial: 250, fecha_objetivo: "2028-02-29", descripcion: "Detalle", estado: "pausada" });
});

test("planning form errors preserve entered data and do not dismiss failed writes", async (t) => {
  let closed = 0;
  const view = renderer(t, MobileGoalForm, { row: { nombre: "Viaje", monto_objetivo: 1000, monto_inicial: 0, estado: "activa" }, busy: false, error: "No se pudo guardar la meta.", onClose: () => { closed++; }, onSave: async () => false });
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(closed, 0); assert.match(view.html(), /role="alert"/); assert.match(view.html(), /No se pudo guardar la meta/);
  assert.equal(view.find((n) => n.type === "input")[0].props.value, "Viaje");
});

test("savings form sends an explicit goal assignment; other movement types clear it", async (t) => {
  let saved;
  const view = renderer(t, MobileMovementForm, { categories: [{ id: 2, nombre: "Ahorro", tipo: "ahorro" }, { id: 4, nombre: "Ingreso", tipo: "ingreso" }], goals: [{ id: 3, nombre: "Viaje" }],
    movement: { id: 1, tipo: "ahorro", fecha: "2026-10-04", categoria_id: 2, descripcion: "Aporte", monto: 100, meta_id: 3 }, busy: false, error: "", onClose() {}, onSave: async (input) => { saved = input; return true; } });
  assert.match(view.html(), /Meta de ahorro \(opcional\)/);
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} }); assert.equal(saved.meta_id, 3);
  view.find((n) => n.type === "select")[0].props.onChange({ target: { value: "ingreso" } });
  view.find((n) => n.type === "select")[1].props.onChange({ target: { value: "4" } });
  await view.find((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} }); assert.equal(saved.meta_id, null);
});

test("planning views show consumed budgets and goal progress as text, with separate routes", (t) => {
  const previous = finance.data; t.after(() => { finance.data = previous; });
  finance.data = { ...previous, budgets: [{ id: 1, categoria: "Servicios", mes: 10, anio: 2026, monto_presupuestado: 600, monto_gastado: 700, monto_disponible: -100, porcentaje_usado: 116.7 }],
    goals: [{ id: 1, nombre: "Viaje", estado: "pausada", monto_objetivo: 1000, monto_ahorrado: 1100, faltante: 0, porcentaje_completado: 110, fecha_objetivo: "2027-01-01" }] };
  pathname = "/presupuestos"; const view = renderer(t, MobileApp);
  assert.match(view.html(), /Consumido/); assert.match(view.html(), /Restante/); assert.match(view.html(), /Superado/); assert.match(view.html(), /aria-valuenow="100"/);
  assert.doesNotMatch(view.html(), /Listado de metas/);
  pathname = "/metas"; assert.match(view.html(), /Pausada/); assert.match(view.html(), /110.0%/); assert.match(view.html(), /1\/1\/2027/);
});

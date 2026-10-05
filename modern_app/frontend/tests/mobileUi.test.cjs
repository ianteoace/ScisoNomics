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
const rechartsProps={};
stub("recharts", Object.fromEntries(["LineChart","Line","XAxis","YAxis","Tooltip","CartesianGrid"].map(name=>[name,(props)=>{rechartsProps[name]=props;return React.createElement('div',{'data-chart':name,'data-width':props.width,'data-height':props.height},props.children);}] )));
const emptyStatistics={summary:{saldo_inicial:0,ingreso:0,gasto:0,balance_final:0},month_totals:{ingreso:0,gasto:0,ahorro:0,inversion:0,balance:0},expenses_by_category:[],trend:Array.from({length:12},(_,i)=>({mes:i+1,ingresos:0,gastos:0})),planificacion:{total_vencido:0,total_pendiente_30_dias:0,total_pagado_mes:0,balance_proyectado_mes:0}};
const emptyReport={month:10,year:2026,ingresos:0,gastos:0,ahorro:0,inversiones:0,balance_operativo:0,disponible_luego_ahorro:0,top_categorias:[],top_movimientos:[],evolucion_ultimos_6_meses:[],presupuestos_excedidos:[],metas:[]};
const emptyAnnual=require('../services/data/financeAnalytics.ts').buildAnnualStatistics(2026,[],[]);
let analytics={data:{statistics:emptyStatistics,rows:[],monthly:emptyReport},loading:false,error:'',reload(){}};
stub('./components/mobile/useMobileAnalytics.ts',{useMobileAnalytics:kind=>({...analytics,data:kind==='statistics'?{statistics:analytics.data?.statistics,rows:analytics.data?.rows}:kind==='monthly'?{monthly:analytics.data?.monthly}:{annual:analytics.data?.annual}})});
const summary = { ingresos: 10000, gastos: 2500, ahorros: 200, inversiones: 300, saldoInicial: 700, saldo: 7700, balance: 7500 };
const finance = { period: "2026-10", data: { categories: [{ id: 1, nombre: "Ingreso Mobile", tipo: "ingreso" }], movements: [], summary, fixedExpenses: [], budgets: [], goals: [], scheduled: [], projection: { total_vencido: 0, total_pendiente_30_dias: 0, total_pagado_mes: 0, balance_proyectado_mes: 0 }, calendar: [] },
  loading: false, busy: false, error: "", notice: "", setPeriod() {}, clearMessages() {}, reload() {}, mutate: async () => true };
let financeEnabled;
stub("./components/mobile/useMobileFinance.ts", { useMobileFinance: (enabled) => { financeEnabled = enabled; return finance; } });
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
  ["/planificacion", "Planificación", /Listado de planificación/, /Calendario financiero|Resumen financiero/],
  ["/calendario", "Calendario", /Calendario financiero/, /Listado de planificación|Resumen financiero/],
  ["/metas", "Metas", /Listado de metas/, /Listado de presupuestos|Listado de gastos fijos|Resumen financiero/],
  ["/estadisticas", "Estadísticas", /Estadísticas financieras/, /Reporte financiero|Resumen financiero/],
  ["/reporte", "Reporte", /Reporte financiero/, /Estadísticas financieras|Resumen financiero/],
  ["/reporte-mensual", "Reporte", /Reporte financiero/, /Estadísticas financieras|Resumen financiero/],
  ["/configuracion", "Configuración", /Configuración local/, /Reporte financiero|Resumen financiero/],
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
  assert.deepEqual(view.find((node) => node.type === "a").map((node) => node.props.href), ["/dashboard", "/movimientos", "/categorias", "/gastos-fijos", "/planificacion", "/calendario", "/presupuestos", "/metas", "/estadisticas", "/reporte", "/configuracion"]);
  view.find((node) => node.props["aria-label"] === "Cerrar")[0].props.onClick({ currentTarget: { focus() {} } });
  assert.doesNotMatch(view.html(), /<dialog/);
});

for (const href of ["/dashboard", "/movimientos", "/categorias", "/gastos-fijos", "/planificacion", "/calendario", "/presupuestos", "/metas", "/estadisticas", "/reporte", "/configuracion"]) test(`drawer navigates to ${href} and closes automatically`, (t) => {
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
  pathname = "/no-implementado"; const view = renderer(t, MobileApp);
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

function financeHook(t, repository, enabled = true) {
  const hookPath = path.join(root, "components/mobile/useMobileFinance.ts"), repoPath = path.join(root, "services/data/financeRepository.ts");
  const oldHook = require.cache[hookPath], oldRepo = require.cache[repoPath];
  stub("./services/data/financeRepository.ts", { getFinanceRepository: async () => repository });
  delete require.cache[hookPath];
  const { useMobileFinance } = require(hookPath);
  t.after(() => { require.cache[hookPath] = oldHook; if (oldRepo) require.cache[repoPath] = oldRepo; else delete require.cache[repoPath]; });
  let value;
  function Probe() { value = useMobileFinance(enabled); return React.createElement("div"); }
  const view = renderer(t, Probe, {}, false);
  return { ...view, value: () => value };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("mobile reload ignores stale periods and does not poll on navigation/render", async (t) => {
  const first = deferred(); let reads = 0;
  const repository = { listGastosProgramados: async () => [], getSchedulingSummary: async () => ({}), listGastosFijos: async () => [], listPresupuestos: async () => [], listMetas: async () => [], listCategorias: async () => [], listMovimientos: async () => [], getSummary: async () => { reads++; return reads === 1 ? first.promise : { ...summary, saldo: 222 }; } };
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
  const repository = { listGastosProgramados: async () => [], getSchedulingSummary: async () => ({}), listGastosFijos: async () => [], listPresupuestos: async () => [], listMetas: async () => [], listCategorias: async () => [], listMovimientos: async () => [], getSummary: async () => { reads++; return summary; } };
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
    { href: "/gastos-fijos", feature: "fixed_expenses" }, { href: "/planificacion", feature: "planning" }, { href: "/presupuestos", feature: "budgets" }, { href: "/metas", feature: "saving_goals" },
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

const { MobileScheduling } = require("../components/mobile/planificacion/MobileScheduling.tsx");
const { MobileSchedulingForm } = require("../components/mobile/planificacion/MobileSchedulingForm.tsx");
const { MobileCalendar } = require("../components/mobile/calendario/MobileCalendar.tsx");
const scheduleRow = { id: 1, descripcion: "Seguro", categoria_id: 2, categoria: "Servicios", monto_estimado: 500, fecha_vencimiento: "2026-10-31", estado: "pendiente", es_recurrente: 1, frecuencia: "mensual" };
const projection = { total_vencido: 0, total_pendiente_30_dias: 500, total_pagado_mes: 0, balance_proyectado_mes: -500 };

test("scheduling form persists desktop fields and clears frequency when recurrence is disabled", async (t) => {
  let saved, closed = 0;
  const view = renderer(t, MobileSchedulingForm, { row: scheduleRow, categories: [{id:2,nombre:"Servicios",tipo:"gasto"}], busy:false,error:"",onClose:()=>{closed++;},onSave:async input=>{saved=input;return true;} });
  assert.match(view.html(),/Frecuencia/);assert.match(view.html(),/Cambiar el estado aquí no registra un movimiento/);
  view.find(n=>n.props.type==="checkbox")[0].props.onChange({target:{checked:false}});
  await view.find(n=>n.type==="form")[0].props.onSubmit({preventDefault(){}});
  assert.equal(saved.frecuencia,null);assert.equal(saved.es_recurrente,0);assert.equal(saved.fecha_vencimiento,"2026-10-31");assert.equal(closed,1);
});

test("scheduling form retains values on failure and validates before save", async (t) => {
  let calls=0,closed=0;
  const view=renderer(t,MobileSchedulingForm,{row:scheduleRow,categories:[{id:2,nombre:"Servicios",tipo:"gasto"}],busy:false,error:"No se pudo guardar",onClose:()=>{closed++;},onSave:async()=>{calls++;return false;}});
  await view.find(n=>n.type==="form")[0].props.onSubmit({preventDefault(){}});assert.equal(calls,1);assert.equal(closed,0);assert.match(view.html(),/role="alert"/);
  view.find(n=>n.type==="input"&&n.props.inputMode==="decimal")[0].props.onChange({target:{value:"0"}});
  await view.find(n=>n.type==="form")[0].props.onSubmit({preventDefault(){}});assert.equal(calls,1);assert.match(view.html(),/mayor a cero/);
});

test("scheduling view filters statuses and offers explicit payment only for pending", (t) => {
  let paid=0;const rows=[scheduleRow,{...scheduleRow,id:2,descripcion:"Pagada",estado:"pagado"},{...scheduleRow,id:3,descripcion:"Cancelada",estado:"cancelado"}];
  const view=renderer(t,MobileScheduling,{rows,summary:projection,onCreate(){},onEdit(){},onDelete(){},onPay(){paid++;}});
  assert.equal(view.find(n=>n.props["aria-label"]?.startsWith("Marcar pagado")).length,1);
  view.find(n=>n.props["aria-label"]==="Marcar pagado Seguro")[0].props.onClick();assert.equal(paid,1);
  view.find(n=>n.type==="select")[0].props.onChange({target:{value:"cancelado"}});assert.equal(view.find(n=>n.props["aria-label"]?.startsWith("Marcar pagado")).length,0);assert.match(view.html(),/Cancelada/);
  assert.match(view.html(),/No es tu saldo actual/);assert.doesNotMatch(view.html(),/<table/);
});

test("calendar renders empty month, local day detail and year transitions without tables", (t) => {
  let selectedPeriod;const view=renderer(t,MobileCalendar,{period:{year:2026,month:12},days:[],busy:false,onPeriod:p=>{selectedPeriod=p;}});
  assert.equal(view.find(n=>n.props["aria-label"]?.endsWith("movimientos")).length,42);assert.match(view.html(),/No hay movimientos en este mes/);assert.doesNotMatch(view.html(),/<table/);
  view.find(n=>n.props["aria-label"]==="Mes siguiente")[0].props.onClick();assert.deepEqual(selectedPeriod,{year:2027,month:1});
  view.find(n=>n.props["aria-label"]==="Mes anterior")[0].props.onClick();assert.deepEqual(selectedPeriod,{year:2026,month:11});
  view.find(n=>n.props["aria-label"]?.startsWith("1\/12\/2026:"))[0].props.onClick();assert.match(view.html(),/No hay eventos para este día/);
});

test("calendar day details show actual typed movements and signed daily balance", (t) => {
  const days=[{fecha:"2026-10-04",movimientos:[{id:1,fecha:"2026-10-04",tipo:"gasto",categoria:"Servicios",descripcion:"Real",monto:100}],totales:{ingreso:0,gasto:100,ahorro:0,inversion:0}}];
  const view=renderer(t,MobileCalendar,{period:{year:2026,month:10},days,busy:false,onPeriod(){}});
  view.find(n=>n.props["aria-label"]==="4/10/2026: 1 movimientos")[0].props.onClick();
  assert.match(view.html(),/Movimiento · Gasto/);assert.match(view.html(),/Balance del día/);assert.match(view.html(),/-\$\s100,00/);assert.doesNotMatch(view.html(),/Planificado|Gasto fijo/);
});

test("payment confirmation is separate from editing and mutations refresh shared state", async (t) => {
  const previous=finance.data,previousMutate=finance.mutate;t.after(()=>{finance.data=previous;finance.mutate=previousMutate;});
  finance.data={...previous,scheduled:[scheduleRow],projection};let paid=0;
  finance.mutate=async action=>{await action({markGastoProgramadoPaid:async id=>{assert.equal(id,1);paid++;}});return true;};
  pathname="/planificacion";const view=renderer(t,MobileApp);
  view.find(n=>n.props["aria-label"]==="Marcar pagado Seguro")[0].props.onClick();assert.match(view.html(),/Registrar pago/);assert.match(view.html(),/gasto real con fecha de hoy/);assert.equal(paid,0);
  view.find(n=>n.type==="button"&&n.props.children==="Confirmar pago")[0].props.onClick();await flush();assert.equal(paid,1);assert.doesNotMatch(view.html(),/<dialog/);
  assert.equal(mobileSections.find(s=>s.href==="/calendario").premium,false);assert.equal(mobileSections.find(s=>s.href==="/planificacion").premium,true);
});

const {MobileStatistics}=require('../components/mobile/estadisticas/MobileStatistics.tsx');
const {MobileReport,MonthlyReportContent,AnnualReportContent}=require('../components/mobile/reporte/MobileReport.tsx');
test('statistics show actual totals, safe category percentages and touch detail separately from projection',(t)=>{
  const old=analytics;t.after(()=>{analytics=old;});
  analytics={...old,data:{statistics:{...emptyStatistics,month_totals:{ingreso:1000,gasto:200,ahorro:50,inversion:25,balance:800},expenses_by_category:[{categoria_id:1,categoria:'Servicios',total:200,movimientos:1}],trend:emptyStatistics.trend.map(r=>({...r,ingresos:1000})),planificacion:{...emptyStatistics.planificacion,balance_proyectado_mes:-5000}},rows:[{id:1,fecha:'2026-10-04',tipo:'gasto',categoria:'Servicios',descripcion:'Real',monto:200,nota:'Detalle'}]}};
  const view=renderer(t,MobileStatistics);assert.match(view.html(),/100.0%/);assert.match(view.html(),/Balance proyectado/);assert.match(view.html(),/\$\s800,00/);
  assert.match(view.html(),/datos completos debajo/);assert.match(view.html(),/línea continua/);assert.match(view.html(),/línea punteada/);assert.match(view.html(),/Ver datos de la evolución/);
  view.find(n=>n.type==='button'&&n.props.children?.some?.(x=>x?.props?.children==='Servicios'))[0].props.onClick();
  assert.match(view.html(),/Movimientos: Servicios/);assert.match(view.html(),/Gasto · /);assert.match(view.html(),/Nota: Detalle/);
  view.find(n=>n.type==='select')[0].props.onChange({target:{value:'1'}});assert.doesNotMatch(view.html(),/<dialog/);
});
test('responsive chart measures actual width, handles resizing and disconnects on unmount',(t)=>{
  const {ResponsiveTrendLines}=require('../components/mobile/analytics/MobileAnalyticsUI.tsx');
  let width=254.9, callback, observed, disconnected=0;
  const previous=global.ResizeObserver;
  global.ResizeObserver=class {constructor(cb){callback=cb;}observe(element){observed=element;}disconnect(){disconnected++;}};
  t.after(()=>{global.ResizeObserver=previous;});
  const view=renderer(t,ResponsiveTrendLines,{title:'Evolución',rows:[{label:'Octubre',ingresos:100,gastos:50}]},false);
  const container=view.find(n=>n.props.role==='img')[0];
  const element={getBoundingClientRect:()=>({width})};container.ref.current=element;
  view.effects();assert.equal(observed,element);
  assert.match(view.html(),/data-chart="LineChart"/);
  assert.equal(rechartsProps.XAxis.type,'category');assert.equal(rechartsProps.XAxis.orientation,'bottom');
  assert.equal(rechartsProps.YAxis.type,'number');assert.equal(rechartsProps.YAxis.orientation,'left');
  assert.equal(rechartsProps.XAxis.xAxisId,0);assert.equal(rechartsProps.YAxis.yAxisId,0);
  assert.equal(rechartsProps.Line.yAxisId,0);assert.deepEqual(rechartsProps.YAxis.domain,[0,'auto']);
  const chartProps=()=>view.find(n=>n.props['data-chart']==='LineChart')[0].props;
  assert.equal(chartProps()['data-width'],254);assert.equal(chartProps()['data-height'],240);
  width=320;callback();assert.equal(chartProps()['data-width'],320);
  width=0;callback();assert.doesNotMatch(view.html(),/data-chart="LineChart"/);
  view.dispose();assert.equal(disconnected,1);
});

test('reports keep monthly operational balance and annual net balance distinct without tables or exports',(t)=>{
  const monthly=renderer(t,MonthlyReportContent,{report:{...emptyReport,ingresos:1000,gastos:100,ahorro:50,inversiones:20,balance_operativo:900,disponible_luego_ahorro:850}});
  assert.match(monthly.html(),/saldo acumulado se consulta en Inicio/);assert.match(monthly.html(),/\$\s900,00/);assert.match(monthly.html(),/\$\s850,00/);
  assert.match(monthly.html(),/No hay metas activas/);assert.doesNotMatch(monthly.html(),/<table|Exportar|Balance proyectado/);
  const annual=require('../services/data/financeAnalytics.ts').buildAnnualStatistics(2026,[{mes:10,ingresos:1000,gastos:100,ahorros:50,inversiones:20,movimientos:4}],[]);
  const view=renderer(t,AnnualReportContent,{report:annual});assert.match(view.html(),/Balance anual/);assert.match(view.html(),/\$\s830,00/);assert.doesNotMatch(view.html(),/<table/);
});
test('report tabs fetch monthly and annual separately, with empty/error states and free metadata',(t)=>{
  const old=analytics;t.after(()=>{analytics=old;});analytics={...old,data:{monthly:emptyReport,annual:emptyAnnual}};
  const view=renderer(t,MobileReport);assert.match(view.html(),/Reporte mensual/);
  view.find(n=>n.type==='button'&&n.props.children==='Anual')[0].props.onClick();assert.match(view.html(),/Año del reporte anual/);assert.match(view.html(),/No hay datos suficientes/);assert.doesNotMatch(view.html(),/Top categorías/);
  analytics={...analytics,error:'Falló la lectura',loading:false,data:null};assert.match(view.html(),/role="alert"/);assert.match(view.html(),/Reintentar/);
  for(const href of ['/estadisticas','/reporte'])assert.equal(mobileSections.find(s=>s.href===href).premium,false);
});
test('analytics routes disable unrelated base reads instead of mounting all financial modules',async(t)=>{
  let reads=0;const view=financeHook(t,{listCategorias:async()=>{reads++;}},false);view.html();view.effects();await flush();view.html();assert.equal(reads,0);assert.equal(view.value().loading,false);
});
function analyticsHook(t,repository,input){
  const p=path.join(root,'components/mobile/useMobileAnalytics.ts'),rp=path.join(root,'services/data/financeRepository.ts'),old=require.cache[p],oldRepo=require.cache[rp];
  stub('./services/data/financeRepository.ts',{getFinanceRepository:async()=>repository});delete require.cache[p];const {useMobileAnalytics}=require(p);
  t.after(()=>{require.cache[p]=old;if(oldRepo)require.cache[rp]=oldRepo;else delete require.cache[rp];});let value;
  function Probe(){value=useMobileAnalytics(input.kind,input.period);return React.createElement('div');}
  return {...renderer(t,Probe,{},false),value:()=>value};
}
test('analytics ignore stale periods, load only selected report and refetch once on explicit retry',async(t)=>{
  const first=deferred(),input={kind:'monthly',period:{year:2026,month:12}};let monthly=0,annual=0,stats=0;
  const view=analyticsHook(t,{getMonthlyReport:async p=>{monthly++;return monthly===1?first.promise:{...emptyReport,month:p.month};},getAnnualStatistics:async()=>{annual++;return emptyAnnual;},getStatistics:async()=>{stats++;return emptyStatistics;}},input);
  view.html();view.effects();await flush();input.period={year:2027,month:1};view.html();view.effects();await flush();view.html();assert.equal(view.value().data.monthly.month,1);
  first.resolve({...emptyReport,month:12});await flush();view.html();assert.equal(view.value().data.monthly.month,1);view.html();view.effects();await flush();assert.equal(monthly,2);
  input.kind='annual';view.html();view.effects();await flush();view.html();assert.equal(annual,1);assert.equal(stats,0);assert.equal(monthly,2);
  view.value().reload();view.html();view.effects();await flush();view.html();assert.equal(annual,2);
});


test("settings show real version and Premium features from the drawer metadata", (t) => {
  pathname = "/configuracion"; const view = renderer(t, MobileApp);
  assert.match(view.html(), new RegExp(`Versión ${require("../package.json").version}`));
  const { mobileSections } = require("../components/mobile/MobileSidebar.tsx");
  const expected = mobileSections.filter(section => section.premium).map(section => section.label);
  assert.deepEqual(view.find(node => node.type === "li").map(node => node.props.children), expected);
  assert.deepEqual(mobileSections.filter(section => section.premium).map(section => section.feature).sort(), ["budgets", "fixed_expenses", "planning", "saving_goals"]);
});

test("pending settings have no fake actions, checkout, sync or Windows updater", (t) => {
  pathname = "/configuracion"; const view = renderer(t, MobileApp);
  view.html(); assert.equal(financeEnabled, false);
  assert.equal(view.find(node => node.type === "button").length, 1); // Only the shell hamburger.
  assert.equal(view.find(node => node.type === "input" || node.type === "form" || node.type === "table").length, 0);
  assert.doesNotMatch(view.html(), /Buscar actualizaciones|Contratar|Sincronizar ahora|Crear backup|Iniciar sesión|localhost/);
  assert.match(view.html(), /scisoftwareco@gmail.com/);
  assert.deepEqual(view.find(node => node.type === "a").map(node => node.props.href), ["/movimientos", "/legal#terminos", "/legal#privacidad", "/legal#aceptacion"]);
});

test("legal route keeps mobile shell and renders the existing single legal source verbatim", (t) => {
  const LegalPage = require("../app/legal/page.tsx").default;
  const legal = renderer(t, LegalPage);
  const content = legal.find(node => node.type === "pre").map(node => node.props.children).join("");
  assert.equal(content, fs.readFileSync(path.join(root, "src-tauri/LICENSE.txt"), "utf8"));
  assert.deepEqual(legal.find(node => node.type === "pre").map(node => node.props.id), ["introduccion", "terminos", "privacidad", "aceptacion"]);
  pathname = "/legal"; const view = renderer(t, MobileApp, { legalContent: React.createElement(LegalPage) });
  assert.match(view.html(), /Documento legal de ScisoNomics/);
  assert.equal(financeEnabled, false);
  assert.match(view.html(), /<h1[^>]*>Legal<\/h1>/);
  view.effects(); assert.equal(pathname, "/legal");
  assert.doesNotMatch(view.html(), /Resumen financiero|Listado de movimientos/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}

const root = path.resolve(__dirname, "..");
const noop = () => {};
let period = { month: 10, year: 2026 }, activeOwner = "local", currentResponse;
let displayedBalance = 0, apiCalls = [];
const sharedUi = {
  get month() { return period.month; }, get year() { return period.year; },
  search: "", setMonth: noop, setYear: noop,
  get saldoActual() { return displayedBalance; },
  setSaldoActual: (value) => { displayedBalance = value; },
};
function stub(name, exports) {
  const filename = name.startsWith(".") ? path.resolve(root, name) : require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub("next/navigation", { useRouter: () => ({ push: noop, replace: noop }), useSearchParams: () => new URLSearchParams() });
stub("./hooks/useDashboardUi.tsx", { useDashboardUi: () => sharedUi });
stub("./hooks/useDebounce.ts", { useDebounce: (value) => value });
stub("./hooks/useToast.ts", { useToast: () => ({ showError: noop, showSuccess: noop }) });
stub("./services/backupDownload.ts", { createSecurityCopyWithSaveDialog: async () => {} });
stub("./services/cloudAuth.ts", { getActiveOwnerId: () => activeOwner });
stub("./services/dashboardRefresh.ts", { subscribeDashboardRefresh: () => noop });
stub("./services/api.ts", { api: {
  movimientos: async (month, year) => { apiCalls.push({ month, year }); return typeof currentResponse === "function" ? currentResponse(month, year) : currentResponse; },
  stats: async () => null,
  gastosProgramados: async () => [], resumenMensual: async () => ({ balance_mensual: 0 }),
  presupuestos: async () => [], gastosFijos: async () => [], metas: async () => [], categorias: async () => [],
} });
const DashboardPage = require("../app/(dashboard)/dashboard/page.tsx").default;
const MovimientosPage = require("../app/(dashboard)/movimientos/page.tsx").default;
const { DashboardView } = require("../components/views/DashboardView.tsx");
const { money } = require("../lib/format.ts");

// Run the actual page load effect with deterministic React state; no browser/network.
function pageFixture(t, Page, initialState = {}) {
  const states = [], effects = [];
  let cursor = 0;
  t.mock.method(React, "useState", (initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = index in initialState ? initialState[index] : typeof initial === "function" ? initial() : initial;
    return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  });
  t.mock.method(React, "useRef", (initial) => ({ current: initial }));
  t.mock.method(React, "useMemo", (callback) => callback());
  t.mock.method(React, "useEffect", (callback) => { effects.push(callback); });
  return {
    render: () => { cursor = 0; effects.length = 0; return Page(); },
    load: async (index) => {
      const cleanup = effects[index]();
      await new Promise(setImmediate);
      return cleanup;
    },
  };
}

function response(previous, current, rows = [], ingreso = 0, gasto = 0) {
  return { rows, summary: { saldo_inicial: previous, saldo_actual: current, ingreso, gasto, balance_final: previous + ingreso - gasto }, visible_count: rows.length, visible_total: 0 };
}

for (const [label, previous, current, month, year] of [
  ["positive rollover", 250000, 250000, 10, 2026],
  ["negative rollover", -50000, -50000, 10, 2026],
  ["December to January", 500000, 500000, 1, 2027],
  ["no history", 0, 0, 10, 2026],
]) {
  test(`dashboard uses backend balance with no rows: ${label}`, async (t) => {
    period = { month, year }; currentResponse = response(previous, current); displayedBalance = 0; apiCalls = [];
    // The initial refresh subscriber sets reloadNonce before the load effect runs.
    const ui = pageFixture(t, DashboardPage, { 10: 1 }); ui.render();
    await ui.load(1);
    const view = ui.render();
    assert.equal(displayedBalance, current);
    assert.equal(view.props.saldoActual, current);
    assert.equal(view.props.summary.saldo_inicial, previous);
    assert.deepEqual(apiCalls, [{ month, year }, { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year }]);
  });
}

test("dashboard trusts the unfiltered summary instead of a filtered row and never adds history twice", async (t) => {
  period = { month: 10, year: 2026 };
  currentResponse = response(700, 850, [{ saldo_acumulado: 650 }], 200, 50);
  const ui = pageFixture(t, DashboardPage, { 10: 1 }); ui.render(); await ui.load(1);
  assert.equal(ui.render().props.saldoActual, 850);
});

test("month change replaces the previous dashboard balance with the new backend carryover", async (t) => {
  period = { month: 9, year: 2026 }; currentResponse = response(0, 700, [{ saldo_acumulado: 700 }], 1000, 300);
  const ui = pageFixture(t, DashboardPage, { 10: 1 }); ui.render(); await ui.load(1);
  assert.equal(displayedBalance, 700);
  period = { month: 10, year: 2026 }; currentResponse = response(700, 700);
  ui.render(); await ui.load(1);
  assert.equal(ui.render().props.saldoActual, 700);
  currentResponse = response(700, 850, [], 200, 50);
  ui.render(); await ui.load(1);
  assert.equal(ui.render().props.saldoActual, 850);
});

test("dashboard preserves the backend ledger balance when savings differ from operating balance", async (t) => {
  period = { month: 10, year: 2026 };
  currentResponse = response(700, 800, [], 200, 50);
  const ui = pageFixture(t, DashboardPage, { 10: 1 }); ui.render(); await ui.load(1);
  assert.equal(ui.render().props.saldoActual, 800);
  assert.equal(ui.render().props.summary.balance_final, 850);
});

test("a response from an old owner cannot publish its balance", async (t) => {
  period = { month: 10, year: 2026 }; currentResponse = response(700, 850); activeOwner = "fixture-owner-A";
  displayedBalance = 123;
  const ui = pageFixture(t, DashboardPage, { 10: 1 }); ui.render();
  const loading = ui.load(1); activeOwner = "fixture-owner-B"; await loading;
  assert.equal(displayedBalance, 123); activeOwner = "local";
});

test("movement date ranges retain the last month's backend balance even without visible rows", async (t) => {
  currentResponse = (month) => month === 12 ? response(0, 700) : response(700, 850, [], 200, 50);
  displayedBalance = 0; apiCalls = [];
  const ui = pageFixture(t, MovimientosPage, { 4: "2026-12-01", 5: "2027-01-31" });
  ui.render(); await ui.load(0);
  assert.equal(displayedBalance, 850);
  assert.deepEqual(apiCalls, [{ month: 12, year: 2026 }, { month: 1, year: 2027 }]);
});

test("dashboard keeps both balance indicators and the monthly operating balance", () => {
  const html = renderToStaticMarkup(React.createElement(DashboardView, {
    summary: { saldo_inicial: 700, ingreso: 200, gasto: 50, balance_final: 850 },
    saldoActual: 850, previous: null, stats: null, upcoming: [], resumenPotente: { balance_mensual: 150 },
    presupuestos: [], gastosFijos: [], metas: [], recentMovements: [], month: 10, year: 2026,
    onMonthChange: noop, onYearChange: noop, onQuickNewMovement: noop, onQuickMovements: noop, onQuickStats: noop,
    onQuickExport: async () => {}, onQuickBackup: async () => {}, loading: false,
  }));
  assert.match(html, /Saldo actual/); assert.match(html, /Saldo del mes anterior/);
  assert.ok(html.includes(money(850))); assert.ok(html.includes(money(700))); assert.ok(html.includes(money(150)));
});

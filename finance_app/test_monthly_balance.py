import logging
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from finance_app.db import Database
from finance_app.services import (
    FinanceService,
    MovimientoInput,
    reset_current_owner_id,
    set_current_owner_id,
)


class MonthlyBalanceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        environment = patch.dict(os.environ, {"LOCALAPPDATA": str(root)})
        environment.start()
        self.addCleanup(environment.stop)
        layout = patch("finance_app.db.ensure_app_data_layout")
        layout.start()
        self.addCleanup(layout.stop)
        token = set_current_owner_id("local")
        self.addCleanup(reset_current_owner_id, token)
        self.db = Database(root / "isolated.db")
        self.db.init_db()
        self.service = FinanceService(self.db)

    def movement(self, fecha, tipo, monto, description="Fixture movement"):
        categories = self.service.list_categorias(tipo)
        if not categories:
            self.service.create_categoria(f"Fixture {tipo}", tipo)
            categories = self.service.list_categorias(tipo)
        self.service.create_movimiento(
            MovimientoInput(fecha, tipo, categories[0]["id"], description, monto)
        )
        with self.db.connect() as conn:
            return conn.execute("SELECT MAX(id) FROM movimientos").fetchone()[0]

    def september(self):
        self.movement("2026-09-01", "ingreso", 1000)
        self.movement("2026-09-30", "gasto", 300)

    def assertBalance(self, month, year, previous, current):
        summary = self.service.get_resumen_mensual_con_saldo(month, year)
        self.assertEqual(summary["saldo_inicial"], previous)
        self.assertEqual(summary["saldo_actual"], current)
        return summary

    def test_positive_month_rollover(self):
        self.movement("2026-09-01", "ingreso", 400000)
        self.movement("2026-09-30", "gasto", 150000)
        september = self.assertBalance(9, 2026, 0, 250000)
        october = self.assertBalance(10, 2026, 250000, 250000)
        self.assertEqual(september["saldo_actual"], october["saldo_inicial"])

    def test_empty_new_month_keeps_previous_balance(self):
        self.september()
        self.assertEqual(self.service.list_movimientos(10, 2026), [])
        self.assertBalance(10, 2026, 700, 700)

    def test_negative_previous_balance_is_not_clamped(self):
        self.movement("2026-09-30", "gasto", 50000)
        self.assertBalance(10, 2026, -50000, -50000)

    def test_current_month_adds_only_its_net_movements(self):
        self.september()
        self.movement("2026-10-01", "ingreso", 200)
        self.movement("2026-10-02", "gasto", 50)
        summary = self.assertBalance(10, 2026, 700, 850)
        self.assertEqual((summary["ingreso"], summary["gasto"], summary["balance"]), (200, 50, 150))

    def test_december_to_january_carries_across_year(self):
        self.movement("2026-12-31", "ingreso", 500000)
        self.assertBalance(12, 2026, 0, 500000)
        self.assertBalance(1, 2027, 500000, 500000)
        self.movement("2027-01-01", "gasto", 500)
        self.assertBalance(1, 2027, 500000, 499500)

    def test_first_month_without_history(self):
        self.movement("2026-10-01", "ingreso", 200)
        self.movement("2026-10-02", "gasto", 50)
        self.assertBalance(10, 2026, 0, 150)

    def test_no_history_and_no_movements_is_zero(self):
        self.assertBalance(10, 2026, 0, 0)

    def test_multiple_previous_months_and_empty_gaps(self):
        self.movement("2024-01-01", "ingreso", 1000)
        self.movement("2024-12-31", "gasto", 100)
        self.movement("2025-06-10", "ingreso", 500)
        self.movement("2026-09-30", "gasto", 200)
        self.assertBalance(10, 2026, 1200, 1200)

    def test_mixed_movements_with_same_date_are_counted_once(self):
        self.september()
        for tipo, amount in [("ingreso", 200), ("gasto", 50), ("ingreso", 100), ("gasto", 25)]:
            self.movement("2026-10-10", tipo, amount)
        self.assertBalance(10, 2026, 700, 925)
        rows = self.service.list_movimientos(10, 2026)
        self.assertEqual(rows[0]["saldo_acumulado"], 925)
        with self.db.connect() as conn:
            before = [tuple(row) for row in conn.execute("SELECT * FROM movimientos ORDER BY id")]
        for _ in range(3):
            self.assertBalance(10, 2026, 700, 925)
        with self.db.connect() as conn:
            after = [tuple(row) for row in conn.execute("SELECT * FROM movimientos ORDER BY id")]
        self.assertEqual(before, after)

    def test_future_deleted_and_other_owner_movements_are_excluded(self):
        self.september()
        self.movement("2026-11-01", "ingreso", 99999)
        removed = self.movement("2026-09-30", "ingreso", 10000)
        self.service.delete_movimiento(removed)
        removed = self.movement("2026-10-01", "gasto", 10000)
        self.service.delete_movimiento(removed)
        other = set_current_owner_id("fixture-other-owner")
        try:
            self.movement("2026-09-01", "ingreso", 10000)
            self.movement("2026-10-01", "gasto", 10000)
        finally:
            reset_current_owner_id(other)
        self.assertBalance(10, 2026, 700, 700)

    def test_savings_and_investments_keep_existing_ledger_semantics(self):
        self.september()
        self.movement("2026-10-01", "ingreso", 200)
        self.movement("2026-10-02", "gasto", 50)
        self.movement("2026-10-03", "ahorro", 20)
        self.movement("2026-10-04", "inversion", 30)
        summary = self.assertBalance(10, 2026, 700, 800)
        self.assertEqual(self.service.list_movimientos(10, 2026)[0]["saldo_acumulado"], 800)
        self.assertBalance(11, 2026, 800, 800)
        # Monthly operating/report indicators retain their separate existing meaning.
        self.assertEqual(summary["balance_final"], 850)
        self.assertEqual(summary["balance"], 150)
        self.assertEqual(summary["disponible_luego_ahorro"], 130)

    def test_edit_and_delete_recalculate_balance_without_stored_rollovers(self):
        self.september()
        current = self.movement("2026-10-01", "gasto", 50)
        category = self.service.list_categorias("gasto")[0]["id"]
        self.assertBalance(10, 2026, 700, 650)
        self.service.update_movimiento(current, MovimientoInput("2026-10-01", "gasto", category, "Fixture edit", 100))
        self.assertBalance(10, 2026, 700, 600)
        self.service.delete_movimiento(current)
        self.assertBalance(10, 2026, 700, 700)

    def test_movements_stats_and_report_share_balance_without_changing_monthly_totals(self):
        self.september()
        self.movement("2026-10-01", "ingreso", 200)
        self.movement("2026-10-02", "gasto", 50)
        with patch("logging.FileHandler", return_value=logging.NullHandler()):
            from modern_app.backend.app import main
        response = main.list_movimientos(month=10, year=2026, tipo="todos", search="no-matching-fixture", categoria="", min_monto=None, max_monto=None, service=self.service)
        self.assertEqual(response["rows"], [])
        self.assertEqual(response["summary"]["saldo_actual"], 850)
        stats = main.get_stats(month=10, year=2026, service=self.service)
        self.assertEqual(stats["summary"], response["summary"])
        self.assertEqual(stats["month_totals"]["balance"], 150)
        report = self.service.get_reporte_mensual_avanzado(10, 2026)
        self.assertEqual((report["ingresos_mes"], report["gastos_mes"], report["balance_operativo"]), (200, 50, 150))
        self.assertEqual(self.service.get_saldo_actual_total(), 850)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Iterable
import sqlite3
import shutil
from pathlib import Path

from .db import Database


@dataclass
class MovimientoInput:
    fecha: str
    tipo: str
    categoria_id: int
    descripcion: str
    monto: float
    meta_id: int | None = None
    nota: str = ""
    tag_ids: list[int] | None = None


@dataclass
class GastoFijoInput:
    categoria_id: int
    descripcion: str
    monto: float
    dia_vencimiento: int
    activo: int


@dataclass
class GastoProgramadoInput:
    descripcion: str
    categoria_id: int
    monto_estimado: float
    fecha_vencimiento: str
    estado: str = "pendiente"
    es_recurrente: int = 0
    frecuencia: str | None = None


@dataclass
class PresupuestoInput:
    categoria_id: int
    mes: int
    anio: int
    monto: float


@dataclass
class MetaAhorroInput:
    nombre: str
    monto_objetivo: float
    monto_inicial: float = 0.0
    fecha_objetivo: str | None = None
    descripcion: str = ""
    estado: str = "activa"


@dataclass
class TagInput:
    nombre: str
    color: str | None = None


class FinanceService:
    def __init__(self, db: Database) -> None:
        self.db = db

    def list_categorias(self, tipo: str | None = None) -> list[dict]:
        query = "SELECT id, nombre, tipo FROM categorias"
        params: tuple = ()
        if tipo:
            query += " WHERE tipo = ?"
            params = (tipo,)
        query += " ORDER BY tipo, nombre"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def create_categoria(self, nombre: str, tipo: str) -> None:
        nombre = nombre.strip()
        if not nombre:
            raise ValueError("El nombre de categoria es obligatorio.")
        if tipo not in ("ingreso", "gasto", "ahorro", "inversion"):
            raise ValueError("El tipo de categoria es obligatorio.")
        try:
            with self.db.connect() as conn:
                conn.execute(
                    "INSERT INTO categorias (nombre, tipo) VALUES (?, ?)",
                    (nombre, tipo),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("Ya existe una categoria con ese nombre y tipo.") from exc
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al crear categoria: {exc}") from exc

    def update_categoria(self, categoria_id: int, nombre: str, tipo: str) -> None:
        nombre = nombre.strip()
        if not nombre:
            raise ValueError("El nombre de categoria es obligatorio.")
        if tipo not in ("ingreso", "gasto", "ahorro", "inversion"):
            raise ValueError("El tipo de categoria es obligatorio.")
        try:
            with self.db.connect() as conn:
                conn.execute(
                    "UPDATE categorias SET nombre = ?, tipo = ? WHERE id = ?",
                    (nombre, tipo, categoria_id),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("Ya existe una categoria con ese nombre y tipo.") from exc
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al actualizar categoria: {exc}") from exc

    def categoria_in_use(self, categoria_id: int) -> bool:
        with self.db.connect() as conn:
            mov = conn.execute(
                "SELECT 1 FROM movimientos WHERE categoria_id = ? LIMIT 1",
                (categoria_id,),
            ).fetchone()
        return bool(mov)

    def delete_categoria(self, categoria_id: int) -> None:
        if self.categoria_in_use(categoria_id):
            raise ValueError("No se puede eliminar esta categoria porque tiene movimientos asociados.")
        try:
            with self.db.connect() as conn:
                conn.execute("DELETE FROM presupuestos WHERE categoria_id = ?", (categoria_id,))
                conn.execute("DELETE FROM gastos_programados WHERE categoria_id = ?", (categoria_id,))
                conn.execute("DELETE FROM gastos_fijos WHERE categoria_id = ?", (categoria_id,))
                deleted = conn.execute("DELETE FROM categorias WHERE id = ?", (categoria_id,))
                if deleted.rowcount == 0:
                    raise ValueError("No se encontro la categoria a eliminar.")
        except sqlite3.IntegrityError as exc:
            raise ValueError("No se puede eliminar esta categoria porque tiene movimientos asociados.") from exc
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al eliminar categoria: {exc}") from exc

    def list_movimientos(self, month: int, year: int, tipo: str | None = None) -> list[dict]:
        self.apply_fixed_expenses_for_month(month, year)
        where = "WHERE strftime('%m', m.fecha) = ? AND strftime('%Y', m.fecha) = ?"
        params: list[str] = [f"{month:02d}", str(year)]
        if tipo in ("ingreso", "gasto", "ahorro"):
            where += " AND m.tipo = ?"
            params.append(tipo)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    m.id,
                    m.fecha,
                    m.tipo,
                    c.nombre AS categoria,
                    m.descripcion,
                    m.monto,
                    m.meta_id,
                    COALESCE(m.nota, '') AS nota,
                    ma.nombre AS meta_nombre,
                    CAST(strftime('%w', m.fecha) AS INTEGER) AS dia_semana_num,
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN m2.tipo = 'ingreso' THEN m2.monto
                                ELSE -m2.monto
                            END
                        ), 0)
                        FROM movimientos m2
                        WHERE m2.fecha < m.fecha OR (m2.fecha = m.fecha AND m2.id <= m.id)
                    ) AS saldo_acumulado
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                LEFT JOIN metas_ahorro ma ON ma.id = m.meta_id
                {where}
                ORDER BY m.fecha DESC, m.id DESC
                """,
                tuple(params),
            ).fetchall()
        result = [dict(row) for row in rows]
        for row in result:
            row["tags"] = self.get_tags_for_movimiento(int(row["id"]))
        return result

    def list_movimientos_by_year(self, year: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT m.id, m.fecha, m.tipo, c.nombre AS categoria, m.descripcion, m.monto
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE strftime('%Y', m.fecha) = ?
                ORDER BY m.fecha DESC, m.id DESC
                """,
                (str(year),),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_movimiento(self, data: MovimientoInput) -> None:
        meta_id = int(data.meta_id) if data.meta_id is not None else None
        if not meta_id or meta_id <= 0:
            meta_id = None
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto, meta_id, nota)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        data.fecha,
                        data.tipo,
                        data.categoria_id,
                        data.descripcion.strip(),
                        data.monto,
                        meta_id,
                        data.nota.strip(),
                    ),
                )
                mov_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                self._replace_movimiento_tags(conn, mov_id, data.tag_ids or [])
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al crear movimiento: {exc}") from exc

    def update_movimiento(self, movimiento_id: int, data: MovimientoInput) -> None:
        meta_id = int(data.meta_id) if data.meta_id is not None else None
        if not meta_id or meta_id <= 0:
            meta_id = None
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    UPDATE movimientos
                    SET fecha = ?, tipo = ?, categoria_id = ?, descripcion = ?, monto = ?, meta_id = ?, nota = ?
                    WHERE id = ?
                    """,
                    (
                        data.fecha,
                        data.tipo,
                        data.categoria_id,
                        data.descripcion.strip(),
                        data.monto,
                        meta_id,
                        data.nota.strip(),
                        movimiento_id,
                    ),
                )
                self._replace_movimiento_tags(conn, movimiento_id, data.tag_ids or [])
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al actualizar movimiento: {exc}") from exc

    def delete_movimiento(self, movimiento_id: int) -> None:
        try:
            with self.db.connect() as conn:
                conn.execute("DELETE FROM movimientos WHERE id = ?", (movimiento_id,))
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al eliminar movimiento: {exc}") from exc

    def get_movimiento(self, movimiento_id: int) -> dict | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT id, fecha, tipo, categoria_id, descripcion, monto
                    , meta_id, COALESCE(nota, '') AS nota
                FROM movimientos
                WHERE id = ?
                """,
                (movimiento_id,),
            ).fetchone()
        payload = dict(row) if row else None
        if payload:
            payload["tags"] = self.get_tags_for_movimiento(movimiento_id)
        return payload

    def _replace_movimiento_tags(self, conn: sqlite3.Connection, movimiento_id: int, tag_ids: list[int]) -> None:
        conn.execute("DELETE FROM movimiento_tags WHERE movimiento_id = ?", (movimiento_id,))
        unique_ids = sorted({int(tag_id) for tag_id in tag_ids if int(tag_id) > 0})
        conn.executemany(
            "INSERT INTO movimiento_tags (movimiento_id, tag_id) VALUES (?, ?)",
            [(movimiento_id, tag_id) for tag_id in unique_ids],
        )

    def get_tags_for_movimiento(self, movimiento_id: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.id, t.nombre, t.color
                FROM movimiento_tags mt
                JOIN tags t ON t.id = mt.tag_id
                WHERE mt.movimiento_id = ?
                ORDER BY t.nombre
                """,
                (movimiento_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_tags(self) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT id, nombre, color FROM tags ORDER BY nombre").fetchall()
        return [dict(row) for row in rows]

    def create_tag(self, data: TagInput) -> None:
        nombre = data.nombre.strip()
        if not nombre:
            raise ValueError("El nombre de etiqueta es obligatorio.")
        with self.db.connect() as conn:
            conn.execute("INSERT INTO tags (nombre, color) VALUES (?, ?)", (nombre, data.color))

    def update_tag(self, tag_id: int, data: TagInput) -> None:
        nombre = data.nombre.strip()
        if not nombre:
            raise ValueError("El nombre de etiqueta es obligatorio.")
        with self.db.connect() as conn:
            conn.execute("UPDATE tags SET nombre = ?, color = ? WHERE id = ?", (nombre, data.color, tag_id))

    def delete_tag(self, tag_id: int) -> None:
        with self.db.connect() as conn:
            conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))

    def list_metas_ahorro(self) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, nombre, monto_objetivo, monto_inicial, fecha_objetivo, descripcion, estado
                FROM metas_ahorro
                ORDER BY created_at DESC, id DESC
                """
            ).fetchall()
            result = []
            for row in rows:
                meta = dict(row)
                ahorrado = float(meta["monto_inicial"] or 0.0) + self._get_ahorro_asignado(conn, int(meta["id"]))
                objetivo = float(meta["monto_objetivo"] or 0.0)
                meta["monto_ahorrado"] = ahorrado
                meta["faltante"] = max(0.0, objetivo - ahorrado)
                meta["porcentaje_completado"] = (ahorrado / objetivo * 100.0) if objetivo > 0 else 0.0
                result.append(meta)
        return result

    def _get_ahorro_asignado(self, conn: sqlite3.Connection, meta_id: int) -> float:
        row = conn.execute(
            "SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos WHERE tipo = 'ahorro' AND meta_id = ?",
            (meta_id,),
        ).fetchone()
        return float(row["total"] or 0.0)

    def create_meta_ahorro(self, data: MetaAhorroInput) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO metas_ahorro (nombre, monto_objetivo, monto_inicial, fecha_objetivo, descripcion, estado, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (data.nombre.strip(), data.monto_objetivo, data.monto_inicial, data.fecha_objetivo, data.descripcion.strip(), data.estado),
            )

    def update_meta_ahorro(self, meta_id: int, data: MetaAhorroInput) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE metas_ahorro
                SET nombre = ?, monto_objetivo = ?, monto_inicial = ?, fecha_objetivo = ?, descripcion = ?, estado = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (data.nombre.strip(), data.monto_objetivo, data.monto_inicial, data.fecha_objetivo, data.descripcion.strip(), data.estado, meta_id),
            )

    def delete_meta_ahorro(self, meta_id: int) -> None:
        with self.db.connect() as conn:
            conn.execute("UPDATE movimientos SET meta_id = NULL WHERE meta_id = ?", (meta_id,))
            conn.execute("DELETE FROM metas_ahorro WHERE id = ?", (meta_id,))

    def get_calendario_mensual(self, month: int, year: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    m.fecha,
                    m.id,
                    m.tipo,
                    m.descripcion,
                    m.monto,
                    c.nombre AS categoria
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE strftime('%m', m.fecha) = ? AND strftime('%Y', m.fecha) = ?
                ORDER BY m.fecha ASC, m.id ASC
                """,
                (f"{month:02d}", str(year)),
            ).fetchall()
            by_day: dict[str, dict] = {}
            for row in rows:
                d = str(row["fecha"])
                if d not in by_day:
                    by_day[d] = {"fecha": d, "movimientos": [], "totales": {"ingreso": 0.0, "gasto": 0.0, "ahorro": 0.0, "inversion": 0.0}}
                item = dict(row)
                by_day[d]["movimientos"].append(item)
                t = "inversion" if ("invers" in str(item["categoria"]).lower()) else item["tipo"]
                if t in by_day[d]["totales"]:
                    by_day[d]["totales"][t] += float(item["monto"] or 0.0)
        return sorted(by_day.values(), key=lambda x: x["fecha"])

    def get_reporte_mensual_avanzado(self, month: int, year: int) -> dict:
        base = self.get_resumen_mensual_con_saldo(month, year)
        by_cat = self.get_expenses_by_category(month, year, "gasto")
        top_gastos = []
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT m.id, m.fecha, m.descripcion, m.monto, c.nombre AS categoria
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE m.tipo = 'gasto'
                AND strftime('%m', m.fecha) = ? AND strftime('%Y', m.fecha) = ?
                ORDER BY m.monto DESC, m.fecha DESC
                LIMIT 5
                """,
                (f"{month:02d}", str(year)),
            ).fetchall()
            top_gastos = [dict(r) for r in rows]
        prev_month = 12 if month == 1 else month - 1
        prev_year = year - 1 if month == 1 else year
        prev = self.get_month_summary(prev_month, prev_year, None)
        current = self.get_month_summary(month, year, None)
        six_months = []
        cursor_month, cursor_year = month, year
        for _ in range(6):
            totals = self.get_month_summary(cursor_month, cursor_year, None)
            six_months.append({"mes": cursor_month, "anio": cursor_year, **totals})
            cursor_month -= 1
            if cursor_month < 1:
                cursor_month = 12
                cursor_year -= 1
        six_months.reverse()
        presupuestos = self.list_presupuestos(month, year)
        metas = self.list_metas_ahorro()
        return {
            "ingresos_mes": float(base["ingreso"]),
            "gastos_mes": float(base["gasto"]),
            "ahorro_mes": float(base["ahorro"]),
            "inversiones_mes": self._get_inversion_total(month, year),
            "balance_operativo": float(base["ingreso"]) - float(base["gasto"]),
            "disponible_luego_ahorro": float(base["ingreso"]) - float(base["gasto"]) - float(base["ahorro"]),
            "categoria_mayor_gasto": by_cat[0] if by_cat else None,
            "top_5_categorias_gasto": by_cat[:5],
            "top_5_movimientos_gasto": top_gastos,
            "comparacion_mes_anterior": {
                "ingreso": current["ingreso"] - prev["ingreso"],
                "gasto": current["gasto"] - prev["gasto"],
                "ahorro": current["ahorro"] - prev["ahorro"],
                "balance": current["balance"] - prev["balance"],
            },
            "variacion_pct_mes_anterior": {
                "ingreso": self.calculate_variation_percent(current["ingreso"], prev["ingreso"]),
                "gasto": self.calculate_variation_percent(current["gasto"], prev["gasto"]),
                "ahorro": self.calculate_variation_percent(current["ahorro"], prev["ahorro"]),
                "balance": self.calculate_variation_percent(current["balance"], prev["balance"]),
            },
            "evolucion_6_meses": six_months,
            "presupuestos_excedidos": [p for p in presupuestos if bool(p["excedido"])],
            "metas_activas": [m for m in metas if m["estado"] == "activa"],
        }

    def backup_database(self, backups_dir: Path) -> Path:
        source = Path(self.db.db_path)
        backups_dir.mkdir(parents=True, exist_ok=True)
        output = backups_dir / f"finanzas_backup_{datetime.now().strftime('%Y-%m-%d_%H-%M')}.db"
        shutil.copy2(source, output)
        return output

    def list_backups(self, backups_dir: Path) -> list[dict]:
        backups_dir.mkdir(parents=True, exist_ok=True)
        files = sorted(backups_dir.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        return [
            {"name": f.name, "path": str(f), "size": f.stat().st_size, "modified_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat()}
            for f in files
        ]

    def restore_database(self, backup_file: Path, backup_before_restore_dir: Path) -> Path:
        if not backup_file.exists():
            raise FileNotFoundError("El backup seleccionado no existe.")
        safety = self.backup_database(backup_before_restore_dir)
        target = Path(self.db.db_path)
        tmp = target.parent / f"tmp_restore_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
        shutil.copy2(backup_file, tmp)
        with sqlite3.connect(tmp) as conn:
            check = conn.execute("PRAGMA integrity_check").fetchone()
            if not check or str(check[0]).lower() != "ok":
                tmp.unlink(missing_ok=True)
                raise ValueError("El backup seleccionado es inválido.")
        shutil.copy2(tmp, target)
        tmp.unlink(missing_ok=True)
        return safety

    def get_config_value(self, key: str, default: str = "") -> str:
        with self.db.connect() as conn:
            row = conn.execute("SELECT value FROM app_config WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else default

    def set_config_value(self, key: str, value: str) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO app_config (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
                """,
                (key, value),
            )

    def get_month_summary(self, month: int, year: int, tipo: str | None = None) -> dict:
        self.apply_fixed_expenses_for_month(month, year)
        where = "WHERE strftime('%m', fecha) = ? AND strftime('%Y', fecha) = ?"
        params: list[str] = [f"{month:02d}", str(year)]
        if tipo in ("ingreso", "gasto", "ahorro"):
            where += " AND tipo = ?"
            params.append(tipo)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT tipo, COALESCE(SUM(monto), 0) AS total
                FROM movimientos
                {where}
                GROUP BY tipo
                """,
                tuple(params),
            ).fetchall()

        totals = {"ingreso": 0.0, "gasto": 0.0, "ahorro": 0.0}
        for row in rows:
            totals[row["tipo"]] = float(row["total"])
        totals["balance"] = totals["ingreso"] - totals["gasto"]
        totals["disponible_luego_ahorro"] = totals["balance"] - totals["ahorro"]
        return totals

    def get_month_totals(self, month: int, year: int) -> dict:
        return self.get_month_summary(month, year, None)

    def get_saldo_inicial(self, month: int, year: int) -> float:
        inicio = date(year, month, 1).isoformat()
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT COALESCE(SUM(
                    CASE
                        WHEN tipo = 'ingreso' THEN monto
                        ELSE -monto
                    END
                ), 0) AS saldo
                FROM movimientos
                WHERE fecha < ?
                """,
                (inicio,),
            ).fetchone()
        return float(row["saldo"] or 0.0)

    def get_resumen_mensual_con_saldo(self, month: int, year: int) -> dict:
        totals = self.get_month_totals(month, year)
        saldo_inicial = self.get_saldo_inicial(month, year)
        ingresos = float(totals["ingreso"] or 0.0)
        gastos = float(totals["gasto"] or 0.0)
        ahorro = float(totals["ahorro"] or 0.0)
        return {
            "saldo_inicial": saldo_inicial,
            "ingreso": ingresos,
            "gasto": gastos,
            "ahorro": ahorro,
            "balance_final": saldo_inicial + ingresos - gastos,
            "balance": ingresos - gastos,
            "disponible_luego_ahorro": ingresos - gastos - ahorro,
        }

    def get_saldo_actual_total(self) -> float:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT COALESCE(SUM(
                    CASE
                        WHEN tipo = 'ingreso' THEN monto
                        ELSE -monto
                    END
                ), 0) AS saldo
                FROM movimientos
                """
            ).fetchone()
        return float(row["saldo"] or 0.0)

    def calculate_variation_percent(self, current: float, previous: float) -> float | None:
        if previous == 0:
            return None
        return ((current - previous) / previous) * 100.0

    def list_gastos_fijos(self) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT gf.id, gf.categoria_id, c.nombre AS categoria, gf.descripcion,
                       gf.monto, gf.dia_vencimiento, gf.activo
                FROM gastos_fijos gf
                JOIN categorias c ON c.id = gf.categoria_id
                ORDER BY gf.activo DESC, gf.dia_vencimiento ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def create_gasto_fijo(self, data: GastoFijoInput) -> None:
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    INSERT INTO gastos_fijos (categoria_id, descripcion, monto, dia_vencimiento, activo)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (data.categoria_id, data.descripcion.strip(), data.monto, data.dia_vencimiento, data.activo),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al crear gasto fijo: {exc}") from exc

    def update_gasto_fijo(self, gasto_id: int, data: GastoFijoInput) -> None:
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    UPDATE gastos_fijos
                    SET categoria_id = ?, descripcion = ?, monto = ?, dia_vencimiento = ?, activo = ?
                    WHERE id = ?
                    """,
                    (data.categoria_id, data.descripcion.strip(), data.monto, data.dia_vencimiento, data.activo, gasto_id),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al actualizar gasto fijo: {exc}") from exc

    def delete_gasto_fijo(self, gasto_id: int) -> None:
        try:
            with self.db.connect() as conn:
                conn.execute("DELETE FROM gastos_fijos WHERE id = ?", (gasto_id,))
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al eliminar gasto fijo: {exc}") from exc

    def get_gasto_fijo(self, gasto_id: int) -> dict | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT id, categoria_id, descripcion, monto, dia_vencimiento, activo
                FROM gastos_fijos
                WHERE id = ?
                """,
                (gasto_id,),
            ).fetchone()
        return dict(row) if row else None

    def apply_fixed_expenses_for_month(self, month: int, year: int) -> int:
        with self.db.connect() as conn:
            fixed_rows = conn.execute(
                """
                SELECT id, categoria_id, descripcion, monto, dia_vencimiento
                FROM gastos_fijos
                WHERE activo = 1
                """
            ).fetchall()

            inserted = 0
            for row in fixed_rows:
                last_day = calendar.monthrange(year, month)[1]
                day = min(int(row["dia_vencimiento"]), last_day)
                movement_date = date(year, month, day).isoformat()
                desc = f"[FIJO] {row['descripcion']}"

                exists = conn.execute(
                    """
                    SELECT 1
                    FROM movimientos
                    WHERE fecha = ?
                      AND tipo = 'gasto'
                      AND categoria_id = ?
                      AND descripcion = ?
                      AND monto = ?
                    LIMIT 1
                    """,
                    (movement_date, row["categoria_id"], desc, row["monto"]),
                ).fetchone()

                if exists:
                    continue

                conn.execute(
                    """
                    INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto)
                    VALUES (?, 'gasto', ?, ?, ?)
                    """,
                    (movement_date, row["categoria_id"], desc, row["monto"]),
                )
                inserted += 1

        return inserted

    def movements_for_export(self, month: int, year: int) -> Iterable[dict]:
        return self.list_movimientos(month, year)

    def get_expenses_by_category(self, month: int, year: int, tipo: str | None = None) -> list[dict]:
        selected_type = "gasto" if tipo in (None, "gasto") else tipo
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    c.id AS categoria_id,
                    c.nombre AS categoria,
                    COALESCE(SUM(m.monto), 0) AS total,
                    COUNT(m.id) AS movimientos
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE m.tipo = ?
                  AND strftime('%m', m.fecha) = ?
                  AND strftime('%Y', m.fecha) = ?
                GROUP BY c.id, c.nombre
                HAVING total > 0
                ORDER BY total DESC
                """,
                (selected_type, f"{month:02d}", str(year)),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_expense_movements_by_category(self, month: int, year: int, category_id: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    m.id,
                    m.fecha,
                    m.descripcion,
                    m.monto,
                    c.nombre AS categoria
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE m.tipo = 'gasto'
                  AND m.categoria_id = ?
                  AND strftime('%m', m.fecha) = ?
                  AND strftime('%Y', m.fecha) = ?
                ORDER BY m.fecha DESC, m.id DESC
                """,
                (category_id, f"{month:02d}", str(year)),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_monthly_trend(self, year: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    CAST(strftime('%m', fecha) AS INTEGER) AS mes,
                    SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) AS ingresos,
                    SUM(CASE WHEN tipo = 'gasto' THEN monto ELSE 0 END) AS gastos
                FROM movimientos
                WHERE strftime('%Y', fecha) = ?
                GROUP BY strftime('%m', fecha)
                ORDER BY mes
                """,
                (str(year),),
            ).fetchall()

        trend_map = {
            int(row["mes"]): {
                "mes": int(row["mes"]),
                "ingresos": float(row["ingresos"] or 0.0),
                "gastos": float(row["gastos"] or 0.0),
            }
            for row in rows
        }
        return [
            trend_map.get(month, {"mes": month, "ingresos": 0.0, "gastos": 0.0})
            for month in range(1, 13)
        ]

    def get_gastos_programados(self, filtro_estado: str | None = None, dias: int | None = None) -> list[dict]:
        query = """
            SELECT gp.id, gp.descripcion, gp.categoria_id, c.nombre AS categoria, gp.monto_estimado,
                   gp.fecha_vencimiento, gp.estado, gp.es_recurrente, gp.frecuencia, gp.created_at
            FROM gastos_programados gp
            JOIN categorias c ON c.id = gp.categoria_id
        """
        where: list[str] = []
        params: list = []

        if filtro_estado in ("pendiente", "pagado", "cancelado"):
            where.append("gp.estado = ?")
            params.append(filtro_estado)

        if isinstance(dias, int) and dias > 0:
            hoy = date.today().isoformat()
            limite = (date.today() + timedelta(days=dias)).isoformat()
            where.append("gp.fecha_vencimiento >= ? AND gp.fecha_vencimiento <= ?")
            params.extend([hoy, limite])

        if where:
            query += " WHERE " + " AND ".join(where)

        query += " ORDER BY gp.fecha_vencimiento ASC, gp.id DESC"
        with self.db.connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def create_gasto_programado(self, data: GastoProgramadoInput) -> None:
        self._validate_gasto_programado(data)
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    INSERT INTO gastos_programados (
                        descripcion, categoria_id, monto_estimado, fecha_vencimiento, estado, es_recurrente, frecuencia
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        data.descripcion.strip(),
                        data.categoria_id,
                        data.monto_estimado,
                        data.fecha_vencimiento,
                        data.estado,
                        data.es_recurrente,
                        data.frecuencia,
                    ),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al crear gasto programado: {exc}") from exc

    def update_gasto_programado(self, gasto_id: int, data: GastoProgramadoInput) -> None:
        self._validate_gasto_programado(data)
        try:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    UPDATE gastos_programados
                    SET descripcion = ?, categoria_id = ?, monto_estimado = ?, fecha_vencimiento = ?,
                        estado = ?, es_recurrente = ?, frecuencia = ?
                    WHERE id = ?
                    """,
                    (
                        data.descripcion.strip(),
                        data.categoria_id,
                        data.monto_estimado,
                        data.fecha_vencimiento,
                        data.estado,
                        data.es_recurrente,
                        data.frecuencia,
                        gasto_id,
                    ),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al actualizar gasto programado: {exc}") from exc

    def delete_gasto_programado(self, gasto_id: int) -> None:
        try:
            with self.db.connect() as conn:
                conn.execute("DELETE FROM gastos_programados WHERE id = ?", (gasto_id,))
        except sqlite3.Error as exc:
            raise RuntimeError(f"Error al eliminar gasto programado: {exc}") from exc

    def get_gasto_programado(self, gasto_id: int) -> dict | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT id, descripcion, categoria_id, monto_estimado, fecha_vencimiento, estado, es_recurrente, frecuencia
                FROM gastos_programados
                WHERE id = ?
                """,
                (gasto_id,),
            ).fetchone()
        return dict(row) if row else None

    def marcar_gasto_programado_pagado(self, gasto_id: int) -> dict:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT id, descripcion, categoria_id, monto_estimado, fecha_vencimiento, estado, es_recurrente, frecuencia
                FROM gastos_programados
                WHERE id = ?
                """,
                (gasto_id,),
            ).fetchone()
            if not row:
                raise ValueError("No se encontró el gasto programado seleccionado.")
            if row["estado"] == "pagado":
                return {"changed": False, "generated_next": False, "is_recurrent": bool(row["es_recurrente"])}

            conn.execute(
                "UPDATE gastos_programados SET estado = 'pagado' WHERE id = ?",
                (gasto_id,),
            )
            conn.execute(
                """
                INSERT INTO movimientos (fecha, tipo, categoria_id, descripcion, monto)
                VALUES (?, 'gasto', ?, ?, ?)
                """,
                (
                    date.today().isoformat(),
                    row["categoria_id"],
                    row["descripcion"],
                    row["monto_estimado"],
                ),
            )
            generated_next = False
            is_recurrent = int(row["es_recurrente"]) == 1
            if is_recurrent:
                current_due_date = datetime.strptime(row["fecha_vencimiento"], "%Y-%m-%d").date()
                next_due_date = self._calculate_next_due_date(current_due_date, row["frecuencia"])
                next_due_iso = next_due_date.isoformat()

                exists_next = conn.execute(
                    """
                    SELECT 1
                    FROM gastos_programados
                    WHERE estado = 'pendiente'
                      AND descripcion = ?
                      AND categoria_id = ?
                      AND monto_estimado = ?
                      AND fecha_vencimiento = ?
                    LIMIT 1
                    """,
                    (row["descripcion"], row["categoria_id"], row["monto_estimado"], next_due_iso),
                ).fetchone()

                if not exists_next:
                    conn.execute(
                        """
                        INSERT INTO gastos_programados (
                            descripcion, categoria_id, monto_estimado, fecha_vencimiento, estado, es_recurrente, frecuencia
                        )
                        VALUES (?, ?, ?, ?, 'pendiente', 1, ?)
                        """,
                        (
                            row["descripcion"],
                            row["categoria_id"],
                            row["monto_estimado"],
                            next_due_iso,
                            row["frecuencia"],
                        ),
                    )
                    generated_next = True

            return {"changed": True, "generated_next": generated_next, "is_recurrent": is_recurrent}

    def _calculate_next_due_date(self, current_due_date: date, frecuencia: str | None) -> date:
        if frecuencia == "semanal":
            return current_due_date + timedelta(days=7)
        if frecuencia == "mensual":
            year = current_due_date.year
            month = current_due_date.month + 1
            if month > 12:
                month = 1
                year += 1
            day = min(current_due_date.day, calendar.monthrange(year, month)[1])
            return date(year, month, day)
        if frecuencia == "anual":
            year = current_due_date.year + 1
            day = min(current_due_date.day, calendar.monthrange(year, current_due_date.month)[1])
            return date(year, current_due_date.month, day)
        raise ValueError("Frecuencia recurrente inválida.")

    def get_planificacion_resumen(self, month: int, year: int) -> dict:
        hoy = date.today().isoformat()
        now = date.today()
        inicio_mes = date(year, month, 1).isoformat()
        fin_mes = date(year, month, calendar.monthrange(year, month)[1]).isoformat()
        inicio_actual = date(now.year, now.month, 1).isoformat()
        fin_actual = date(now.year, now.month, calendar.monthrange(now.year, now.month)[1]).isoformat()

        with self.db.connect() as conn:
            pendiente_30 = conn.execute(
                """
                SELECT COALESCE(SUM(monto_estimado), 0) AS total
                FROM gastos_programados
                WHERE estado = 'pendiente'
                  AND fecha_vencimiento >= ?
                  AND fecha_vencimiento <= ?
                """,
                (hoy, (date.today() + timedelta(days=30)).isoformat()),
            ).fetchone()

            vencido = conn.execute(
                """
                SELECT COALESCE(SUM(monto_estimado), 0) AS total
                FROM gastos_programados
                WHERE estado = 'pendiente' AND fecha_vencimiento < ?
                """,
                (hoy,),
            ).fetchone()

            pagado_mes = conn.execute(
                """
                SELECT COALESCE(SUM(monto_estimado), 0) AS total
                FROM gastos_programados
                WHERE estado = 'pagado'
                  AND fecha_vencimiento >= ?
                  AND fecha_vencimiento <= ?
                """,
                (inicio_actual, fin_actual),
            ).fetchone()

            reales_mes = conn.execute(
                """
                SELECT
                    COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
                    COALESCE(SUM(CASE WHEN tipo = 'gasto' THEN monto ELSE 0 END), 0) AS gastos
                FROM movimientos
                WHERE fecha >= ? AND fecha <= ?
                """,
                (inicio_mes, fin_mes),
            ).fetchone()

            programados_pendientes_mes = conn.execute(
                """
                SELECT COALESCE(SUM(monto_estimado), 0) AS total
                FROM gastos_programados
                WHERE estado = 'pendiente'
                  AND fecha_vencimiento >= ?
                  AND fecha_vencimiento <= ?
                """,
                (inicio_mes, fin_mes),
            ).fetchone()

        ingresos = float(reales_mes["ingresos"] or 0.0)
        gastos = float(reales_mes["gastos"] or 0.0)
        pendientes_mes = float(programados_pendientes_mes["total"] or 0.0)
        return {
            "total_pendiente_30_dias": float(pendiente_30["total"] or 0.0),
            "total_vencido": float(vencido["total"] or 0.0),
            "total_pagado_mes": float(pagado_mes["total"] or 0.0),
            "balance_proyectado_mes": ingresos - gastos - pendientes_mes,
        }

    def _validate_gasto_programado(self, data: GastoProgramadoInput) -> None:
        descripcion = data.descripcion.strip()
        if not descripcion:
            raise ValueError("La descripción es obligatoria.")
        if data.estado not in ("pendiente", "pagado", "cancelado"):
            raise ValueError("El estado es inválido.")
        if data.monto_estimado <= 0:
            raise ValueError("El monto estimado debe ser mayor a 0.")
        try:
            datetime.strptime(data.fecha_vencimiento, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("La fecha de vencimiento debe tener formato YYYY-MM-DD.") from exc
        if int(data.es_recurrente) not in (0, 1):
            raise ValueError("El campo recurrente es inválido.")
        if int(data.es_recurrente) == 1 and data.frecuencia not in ("mensual", "semanal", "anual"):
            raise ValueError("La frecuencia es obligatoria para gastos recurrentes.")
        if int(data.es_recurrente) == 0:
            data.frecuencia = None

    def list_presupuestos(self, month: int, year: int) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    p.id,
                    p.categoria_id,
                    c.nombre AS categoria,
                    p.mes,
                    p.anio,
                    p.monto AS monto_presupuestado,
                    COALESCE(SUM(CASE WHEN m.tipo = 'gasto' THEN m.monto ELSE 0 END), 0) AS monto_gastado
                FROM presupuestos p
                JOIN categorias c ON c.id = p.categoria_id
                LEFT JOIN movimientos m
                  ON m.categoria_id = p.categoria_id
                 AND m.tipo = 'gasto'
                 AND strftime('%m', m.fecha) = printf('%02d', p.mes)
                 AND strftime('%Y', m.fecha) = CAST(p.anio AS TEXT)
                WHERE p.mes = ? AND p.anio = ?
                GROUP BY p.id, p.categoria_id, c.nombre, p.mes, p.anio, p.monto
                ORDER BY c.nombre
                """,
                (month, year),
            ).fetchall()
        result: list[dict] = []
        for row in rows:
            budget = float(row["monto_presupuestado"] or 0.0)
            spent = float(row["monto_gastado"] or 0.0)
            used_pct = (spent / budget * 100.0) if budget > 0 else 0.0
            result.append(
                {
                    **dict(row),
                    "monto_gastado": spent,
                    "porcentaje_usado": used_pct,
                    "monto_disponible": budget - spent,
                    "excedido": spent > budget,
                }
            )
        return result

    def create_or_update_presupuesto(self, data: PresupuestoInput) -> None:
        if data.mes < 1 or data.mes > 12:
            raise ValueError("Mes invalido.")
        if data.monto <= 0:
            raise ValueError("El monto debe ser mayor a 0.")
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO presupuestos (categoria_id, mes, anio, monto, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(categoria_id, mes, anio)
                DO UPDATE SET monto = excluded.monto, updated_at = CURRENT_TIMESTAMP
                """,
                (data.categoria_id, data.mes, data.anio, data.monto),
            )

    def delete_presupuesto(self, presupuesto_id: int) -> None:
        with self.db.connect() as conn:
            conn.execute("DELETE FROM presupuestos WHERE id = ?", (presupuesto_id,))

    def get_resumen_mensual_potente(self, month: int, year: int) -> dict:
        summary = self.get_resumen_mensual_con_saldo(month, year)
        prev_month = 12 if month == 1 else month - 1
        prev_year = year - 1 if month == 1 else year
        prev = self.get_month_summary(prev_month, prev_year)
        by_cat = self.get_expenses_by_category(month, year, "gasto")
        top_category = by_cat[0] if by_cat else None
        ahorro_mes = float(summary.get("ahorro", 0.0))
        prev_balance = float(prev["balance"])
        current_balance = float(summary["balance"])
        variation_pct = ((current_balance - prev_balance) / abs(prev_balance) * 100.0) if prev_balance else None
        upcoming = self.get_gastos_programados("pendiente", 30)
        return {
            "ingresos_mes": float(summary["ingreso"]),
            "gastos_mes": float(summary["gasto"]),
            "ahorro_mes": ahorro_mes,
            "balance_mensual": current_balance,
            "disponible_luego_ahorro": current_balance - ahorro_mes,
            "categoria_mayor_gasto": top_category,
            "balance_mes_anterior": prev_balance,
            "variacion_pct_vs_mes_anterior": variation_pct,
            "proximos_gastos_fijos": upcoming[:8],
            "balance_positivo": current_balance >= 0,
        }

    def _get_inversion_total(self, month: int, year: int) -> float:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT COALESCE(SUM(m.monto), 0) AS total
                FROM movimientos m
                JOIN categorias c ON c.id = m.categoria_id
                WHERE strftime('%m', m.fecha) = ?
                  AND strftime('%Y', m.fecha) = ?
                  AND lower(c.nombre) LIKE '%invers%'
                """,
                (f"{month:02d}", str(year)),
            ).fetchone()
        return float(row["total"] or 0.0)

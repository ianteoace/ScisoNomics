from __future__ import annotations

from datetime import datetime
from pathlib import Path
from tempfile import gettempdir, mkdtemp
from typing import Literal
import csv
import io
import logging
import os
import sys

import shutil
import sqlite3
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from finance_app.exporter import export_date_range_report, export_filtered_movimientos, export_monthly_report, export_yearly_report
from finance_app.services import FinanceService, GastoFijoInput, GastoProgramadoInput, MetaAhorroInput, MovimientoInput, PresupuestoInput, TagInput
from finance_app.paths import get_app_data_dir, get_backup_dir, get_data_dir, get_db_path, get_logs_dir
from openpyxl import load_workbook

from .deps import ensure_app_data_initialized, get_last_init_status, get_service
from .settings import ORIGINAL_DB_PATH, WEB_DB_PATH
from .schemas import BackupFrequencyIn, BackupRestoreIn, BackupRestorePathIn, CategoriaIn, GastoFijoIn, GastoProgramadoIn, MetaAhorroIn, MovimientoIn, PresupuestoIn, TagIn

app = FastAPI(title="Registro Finanzas API", version="2.0.0")

_LOG_FILE = get_logs_dir() / "backend-startup.log"
_logger = logging.getLogger("scisonomics.backend")
if not _logger.handlers:
    _logger.setLevel(logging.INFO)
    _handler: logging.Handler | None = None
    for candidate in (
        _LOG_FILE,
        get_app_data_dir() / "logs" / "backend-startup.log",
        Path.cwd() / "backend-startup.log",
    ):
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            _handler = logging.FileHandler(candidate, encoding="utf-8")
            break
        except OSError:
            continue
    if _handler is None:
        _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    _logger.addHandler(_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(FileNotFoundError)
async def file_not_found_handler(_: Request, exc: FileNotFoundError):
    return JSONResponse(status_code=500, content={"detail": str(exc) or "Error de archivo local."})


def _yes_no(value: bool) -> str:
    return "si" if value else "no"


@app.on_event("startup")
def log_db_path() -> None:
    try:
        ensure_app_data_initialized()
        exists = WEB_DB_PATH.exists()
        size_bytes = WEB_DB_PATH.stat().st_size if exists else 0
        print(f"Usando base SQLite: {WEB_DB_PATH.resolve()}")
        print(f"Existe: {_yes_no(exists)}")
        print(f"Tamaño: {size_bytes} bytes")
        _logger.info("Startup backend OK. db=%s exists=%s size=%s", WEB_DB_PATH.resolve(), exists, size_bytes)
    except Exception as exc:
        _logger.exception("Error en startup backend: %s", exc)
        raise


@app.get("/health")
def health(service: FinanceService = Depends(get_service)):
    try:
        ensure_app_data_initialized()
        status = get_last_init_status()
        db_path = Path(str(status.get("db_path", service.db.db_path)))
        db_exists = bool(status.get("db_exists", db_path.exists()))
        db_initialized = bool(status.get("db_initialized", False))
        return {
            "ok": True,
            "db_path": str(db_path),
            "db_exists": db_exists,
            "db_initialized": db_initialized,
            "data_dir": str(status.get("data_dir", get_data_dir())),
            "backups_dir": str(status.get("backups_dir", get_backup_dir())),
            "logs_dir": str(status.get("logs_dir", get_logs_dir())),
            "frozen": bool(getattr(sys, "frozen", False)),
            "executable": str(sys.executable),
            "version": app.version,
        }
    except Exception as exc:
        _logger.exception("Error en /health: %s", exc)
        status = get_last_init_status()
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "Error de inicializacion del backend local.",
                "detail": str(exc),
                "db_path": str(status.get("db_path", WEB_DB_PATH)),
                "logs_path": str(get_logs_dir() / "backend-startup.log"),
            },
        )


@app.get("/meta")
def meta(service: FinanceService = Depends(get_service)):
    return {
        "database": {
            "working_copy": str(service.db.db_path),
            "original": str(ORIGINAL_DB_PATH),
        }
    }


@app.get("/debug/db-path")
def debug_db_path(service: FinanceService = Depends(get_service)):
    db_path = Path(service.db.db_path).resolve()
    exists = db_path.exists()
    size_bytes = db_path.stat().st_size if exists else 0
    counts = {
        "movimientos_count": 0,
        "categorias_count": 0,
        "gastos_fijos_count": 0,
        "gastos_programados_count": 0,
    }
    if exists:
        with service.db.connect() as conn:
            counts["movimientos_count"] = int(conn.execute("SELECT COUNT(*) FROM movimientos").fetchone()[0])
            counts["categorias_count"] = int(conn.execute("SELECT COUNT(*) FROM categorias").fetchone()[0])
            counts["gastos_fijos_count"] = int(conn.execute("SELECT COUNT(*) FROM gastos_fijos").fetchone()[0])
            counts["gastos_programados_count"] = int(conn.execute("SELECT COUNT(*) FROM gastos_programados").fetchone()[0])
    return {
        "db_path": str(db_path),
        "exists": exists,
        "size_bytes": size_bytes,
        **counts,
    }


@app.get("/movimientos")
def list_movimientos(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None),
    tipo: Literal["todos", "ingreso", "gasto", "inversion", "ahorro"] = "todos",
    search: str = "",
    categoria: str = "",
    min_monto: float | None = Query(default=None, ge=0),
    max_monto: float | None = Query(default=None, ge=0),
    service: FinanceService = Depends(get_service),
):
    now = datetime.now()
    month = month if month is not None else now.month
    year = year if year is not None else now.year
    current_type = None if tipo in ("todos", "inversion") else tipo
    rows = service.list_movimientos(month, year, current_type)
    if tipo == "inversion":
        rows = [r for r in rows if "invers" in str(r.get("categoria", "")).lower()]
    term = search.strip().lower()
    category_term = categoria.strip().lower()
    if term:
        rows = [
            row
            for row in rows
            if term in str(row.get("descripcion", "")).lower()
            or term in str(row.get("categoria", "")).lower()
            or term in str(row.get("fecha", "")).lower()
        ]
    if category_term:
        rows = [row for row in rows if category_term in str(row.get("categoria", "")).lower()]
    if min_monto is not None:
        rows = [row for row in rows if float(row.get("monto", 0) or 0) >= min_monto]
    if max_monto is not None:
        rows = [row for row in rows if float(row.get("monto", 0) or 0) <= max_monto]

    summary = service.get_resumen_mensual_con_saldo(month, year)
    visible_total = sum(float(r["monto"]) if r["tipo"] == "ingreso" else -float(r["monto"]) for r in rows)
    return {
        "rows": rows,
        "summary": summary,
        "visible_count": len(rows),
        "visible_total": visible_total,
    }


@app.post("/movimientos")
def create_movimiento(payload: MovimientoIn, service: FinanceService = Depends(get_service)):
    try:
        service.create_movimiento(MovimientoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/movimientos/{movimiento_id}")
def update_movimiento(movimiento_id: int, payload: MovimientoIn, service: FinanceService = Depends(get_service)):
    try:
        service.update_movimiento(movimiento_id, MovimientoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/movimientos/{movimiento_id}")
def delete_movimiento(movimiento_id: int, service: FinanceService = Depends(get_service)):
    try:
        service.delete_movimiento(movimiento_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/categorias")
def list_categorias(tipo: Literal["ingreso", "gasto", "ahorro", "inversion", "todos"] = "todos", service: FinanceService = Depends(get_service)):
    return service.list_categorias(None if tipo == "todos" else tipo)


@app.post("/categorias")
def create_categoria(payload: CategoriaIn, service: FinanceService = Depends(get_service)):
    try:
        service.create_categoria(payload.nombre, payload.tipo)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/categorias/{categoria_id}")
def update_categoria(categoria_id: int, payload: CategoriaIn, service: FinanceService = Depends(get_service)):
    try:
        service.update_categoria(categoria_id, payload.nombre, payload.tipo)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/categorias/{categoria_id}")
def delete_categoria(categoria_id: int, service: FinanceService = Depends(get_service)):
    try:
        service.delete_categoria(categoria_id)
        return {"ok": True}
    except ValueError as exc:
        message = str(exc)
        if "movimientos asociados" in message.lower():
            raise HTTPException(status_code=409, detail="No se puede eliminar esta categoría porque tiene movimientos asociados.") from exc
        if "no se encontro la categoria" in message.lower() or "no se encontró la categoria" in message.lower():
            raise HTTPException(status_code=404, detail="No se encontró la categoría.") from exc
        raise HTTPException(status_code=400, detail=message) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/gastos-fijos")
def list_gastos_fijos(service: FinanceService = Depends(get_service)):
    return service.list_gastos_fijos()


@app.post("/gastos-fijos")
def create_gasto_fijo(payload: GastoFijoIn, service: FinanceService = Depends(get_service)):
    try:
        service.create_gasto_fijo(GastoFijoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/gastos-fijos/{gasto_id}")
def update_gasto_fijo(gasto_id: int, payload: GastoFijoIn, service: FinanceService = Depends(get_service)):
    try:
        service.update_gasto_fijo(gasto_id, GastoFijoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/gastos-fijos/{gasto_id}")
def delete_gasto_fijo(gasto_id: int, service: FinanceService = Depends(get_service)):
    try:
        service.delete_gasto_fijo(gasto_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/gastos-programados")
def list_gastos_programados(
    estado: Literal["pendiente", "pagado", "cancelado", "todos"] = "todos",
    dias: int | None = Query(default=None, ge=1),
    service: FinanceService = Depends(get_service),
):
    filtro_estado = None if estado == "todos" else estado
    rows = service.get_gastos_programados(filtro_estado, dias)
    return rows


@app.post("/gastos-programados")
def create_gasto_programado(payload: GastoProgramadoIn, service: FinanceService = Depends(get_service)):
    try:
        service.create_gasto_programado(GastoProgramadoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/gastos-programados/{gasto_id}")
def update_gasto_programado(gasto_id: int, payload: GastoProgramadoIn, service: FinanceService = Depends(get_service)):
    try:
        service.update_gasto_programado(gasto_id, GastoProgramadoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/gastos-programados/{gasto_id}")
def delete_gasto_programado(gasto_id: int, service: FinanceService = Depends(get_service)):
    try:
        service.delete_gasto_programado(gasto_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/gastos-programados/{gasto_id}/marcar-pagado")
def marcar_pagado(gasto_id: int, service: FinanceService = Depends(get_service)):
    try:
        return service.marcar_gasto_programado_pagado(gasto_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/estadisticas")
def get_stats(month: int = Query(..., ge=1, le=12), year: int = Query(...), service: FinanceService = Depends(get_service)):
    summary = service.get_resumen_mensual_con_saldo(month, year)
    expenses_by_category = service.get_expenses_by_category(month, year, "gasto")
    trend = service.get_monthly_trend(year)
    plan = service.get_planificacion_resumen(month, year)
    month_totals = service.get_month_summary(month, year, None)
    return {
        "summary": summary,
        "month_totals": month_totals,
        "expenses_by_category": expenses_by_category,
        "trend": trend,
        "planificacion": plan,
    }


@app.get("/estadisticas/anual")
def get_stats_anual(year: int = Query(...), service: FinanceService = Depends(get_service)):
    with service.db.connect() as conn:
        totals_row = conn.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN tipo='gasto' THEN monto ELSE 0 END), 0) AS gastos,
              COALESCE(SUM(CASE WHEN tipo='ahorro' THEN monto ELSE 0 END), 0) AS ahorros,
              COALESCE(SUM(CASE WHEN tipo='inversion' THEN monto ELSE 0 END), 0) AS inversiones,
              COUNT(*) AS movimientos
            FROM movimientos
            WHERE strftime('%Y', fecha) = ?
            """,
            (str(year),),
        ).fetchone()

        monthly_rows = conn.execute(
            """
            SELECT
              CAST(strftime('%m', fecha) AS INTEGER) AS mes,
              COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN tipo='gasto' THEN monto ELSE 0 END), 0) AS gastos,
              COALESCE(SUM(CASE WHEN tipo='ahorro' THEN monto ELSE 0 END), 0) AS ahorros,
              COALESCE(SUM(CASE WHEN tipo='inversion' THEN monto ELSE 0 END), 0) AS inversiones
            FROM movimientos
            WHERE strftime('%Y', fecha) = ?
            GROUP BY strftime('%m', fecha)
            ORDER BY mes
            """,
            (str(year),),
        ).fetchall()

        categories_rows = conn.execute(
            """
            SELECT c.nombre AS categoria, COALESCE(SUM(m.monto),0) AS total, COUNT(m.id) AS movimientos
            FROM movimientos m
            JOIN categorias c ON c.id = m.categoria_id
            WHERE strftime('%Y', m.fecha) = ? AND m.tipo = 'gasto'
            GROUP BY c.nombre
            HAVING total > 0
            ORDER BY total DESC
            """,
            (str(year),),
        ).fetchall()

    by_month = {
        int(row["mes"]): {
            "mes": int(row["mes"]),
            "ingresos": float(row["ingresos"] or 0),
            "gastos": float(row["gastos"] or 0),
            "ahorros": float(row["ahorros"] or 0),
            "inversiones": float(row["inversiones"] or 0),
        }
        for row in monthly_rows
    }
    monthly = []
    for m in range(1, 13):
        item = by_month.get(m, {"mes": m, "ingresos": 0.0, "gastos": 0.0, "ahorros": 0.0, "inversiones": 0.0})
        item["balance"] = item["ingresos"] - item["gastos"] - item["ahorros"] - item["inversiones"]
        monthly.append(item)

    total_ingresos = float(totals_row["ingresos"] or 0)
    total_gastos = float(totals_row["gastos"] or 0)
    total_ahorros = float(totals_row["ahorros"] or 0)
    total_inversiones = float(totals_row["inversiones"] or 0)
    balance_anual = total_ingresos - total_gastos - total_ahorros - total_inversiones
    movimientos_total = int(totals_row["movimientos"] or 0)

    mes_mayor_gasto = max(monthly, key=lambda x: x["gastos"]) if monthly else None
    mes_mayor_ingreso = max(monthly, key=lambda x: x["ingresos"]) if monthly else None
    categoria_mayor_gasto = dict(categories_rows[0]) if categories_rows else None

    return {
        "year": year,
        "totals": {
            "ingresos": total_ingresos,
            "gastos": total_gastos,
            "ahorros": total_ahorros,
            "inversiones": total_inversiones,
            "balance": balance_anual,
            "movimientos": movimientos_total,
        },
        "promedios_mensuales": {
            "ingresos": total_ingresos / 12.0,
            "gastos": total_gastos / 12.0,
            "balance": balance_anual / 12.0,
        },
        "mes_mayor_gasto": mes_mayor_gasto,
        "mes_mayor_ingreso": mes_mayor_ingreso,
        "categoria_mayor_gasto": categoria_mayor_gasto,
        "monthly": monthly,
        "gastos_por_categoria": [dict(r) for r in categories_rows],
    }


@app.get("/resumen-mensual")
def resumen_mensual(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None),
    mes: int | None = Query(default=None, ge=1, le=12),
    anio: int | None = Query(default=None),
    service: FinanceService = Depends(get_service),
):
    month = month if month is not None else mes
    year = year if year is not None else anio
    if month is None or year is None:
        raise HTTPException(status_code=400, detail="Debes indicar month/year o mes/anio.")
    return service.get_resumen_mensual_potente(month, year)


@app.get("/presupuestos")
def list_presupuestos(month: int = Query(..., ge=1, le=12), year: int = Query(...), service: FinanceService = Depends(get_service)):
    return service.list_presupuestos(month, year)


@app.post("/presupuestos")
def upsert_presupuesto(payload: PresupuestoIn, service: FinanceService = Depends(get_service)):
    try:
        service.create_or_update_presupuesto(PresupuestoInput(**payload.model_dump()))
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/presupuestos/{presupuesto_id}")
def delete_presupuesto(presupuesto_id: int, service: FinanceService = Depends(get_service)):
    try:
        service.delete_presupuesto(presupuesto_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/settings/info")
def settings_info(service: FinanceService = Depends(get_service)):
    ensure_app_data_initialized()
    status = get_last_init_status()
    db_path = Path(str(status.get("db_path", service.db.db_path)))
    data_dir = Path(str(status.get("data_dir", get_data_dir())))
    backups_dir = Path(str(status.get("backups_dir", get_backup_dir())))
    logs_dir = Path(str(status.get("logs_dir", get_logs_dir())))
    exists = db_path.exists()
    size_bytes = db_path.stat().st_size if exists else 0
    counts = {"movimientos": 0, "categorias": 0, "presupuestos": 0, "metas": 0}
    if exists:
        with service.db.connect() as conn:
            counts["movimientos"] = int(conn.execute("SELECT COUNT(*) FROM movimientos").fetchone()[0])
            counts["categorias"] = int(conn.execute("SELECT COUNT(*) FROM categorias").fetchone()[0])
            counts["presupuestos"] = int(conn.execute("SELECT COUNT(*) FROM presupuestos").fetchone()[0])
            counts["metas"] = int(conn.execute("SELECT COUNT(*) FROM metas_ahorro").fetchone()[0])
    return {
        "version": app.version,
        "backend_ok": True,
        "db_path": str(db_path),
        "db_exists": exists,
        "db_size": size_bytes,
        "data_dir": str(data_dir),
        "backups_dir": str(backups_dir),
        "logs_dir": str(logs_dir),
        "logs_exists": logs_dir.exists(),
        "app_data_dir": str(get_app_data_dir()),
        "migrations_status": "ok",
        "db_initialized": bool(status.get("db_initialized", False)),
        "frozen": bool(getattr(sys, "frozen", False)),
        "executable": str(sys.executable),
        "counts": counts,
    }


@app.get("/sync/status")
def sync_status(service: FinanceService = Depends(get_service)):
    ensure_app_data_initialized()
    candidate_tables = [
        "movimientos",
        "categorias",
        "presupuestos",
        "metas_ahorro",
        "gastos_fijos",
        "gastos_programados",
        "tags",
        "movimiento_tags",
    ]
    tables: dict[str, dict[str, int | bool]] = {}
    with service.db.connect() as conn:
        existing_tables = {
            str(row["name"])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table in candidate_tables:
            if table not in existing_tables:
                continue
            columns = {
                str(row["name"])
                for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
            }
            has_sync_columns = {"sync_id", "sync_status", "deleted_at"}.issubset(columns)
            if not has_sync_columns:
                tables[table] = {
                    "total": int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]),
                    "pending": 0,
                    "synced": 0,
                    "deleted": 0,
                    "missing_sync_id": 0,
                    "sync_ready": False,
                }
                continue
            row = conn.execute(
                f"""
                SELECT
                  COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                  COALESCE(SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END), 0) AS synced,
                  COALESCE(SUM(CASE WHEN sync_status = 'deleted' OR deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted,
                  COALESCE(SUM(CASE WHEN sync_id IS NULL OR trim(sync_id) = '' THEN 1 ELSE 0 END), 0) AS missing_sync_id
                FROM {table}
                """
            ).fetchone()
            tables[table] = {
                "total": int(row["total"] or 0),
                "pending": int(row["pending"] or 0),
                "synced": int(row["synced"] or 0),
                "deleted": int(row["deleted"] or 0),
                "missing_sync_id": int(row["missing_sync_id"] or 0),
                "sync_ready": int(row["missing_sync_id"] or 0) == 0,
            }

    return {
        "ok": True,
        "sync_ready": all(bool(info.get("sync_ready")) for info in tables.values()),
        "tables": tables,
    }


@app.post("/backup/export")
def export_backup(service: FinanceService = Depends(get_service)):
    source = Path(service.db.db_path)
    if not source.exists():
        raise HTTPException(status_code=404, detail="No existe la base de datos.")
    output = Path(mkdtemp(prefix="finanzas_backup_")) / f"backup_finanzas_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    shutil.copy2(source, output)
    return FileResponse(path=output, filename=output.name, media_type="application/octet-stream")


@app.post("/backup/restore")
async def restore_backup(request: Request, service: FinanceService = Depends(get_service)):
    try:
        ensure_app_data_initialized()
        try:
            payload = await request.json()
        except Exception as exc:
            _logger.exception("Body invalido en restauracion de copia: %s", exc)
            raise HTTPException(status_code=400, detail="Solicitud invalida para restaurar copia de seguridad.") from exc

        _logger.info("Payload recibido en /backup/restore: keys=%s", list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__)
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Solicitud invalida para restaurar copia de seguridad.")

        source_path_value = str(payload.get("source_path") or "").strip()
        if not source_path_value:
            raise HTTPException(status_code=400, detail="Debes indicar source_path.")

        source = Path(source_path_value).expanduser()
        _logger.info(
            "Restaurar copia solicitado. source_path=%s exists=%s is_file=%s size=%s",
            source,
            source.exists(),
            source.is_file() if source.exists() else False,
            source.stat().st_size if source.exists() and source.is_file() else None,
        )
        if not source.exists():
            raise HTTPException(status_code=400, detail="La copia seleccionada no existe.")
        if not source.is_file():
            raise HTTPException(status_code=400, detail="La ruta seleccionada no es un archivo valido.")
        if source.stat().st_size <= 0:
            raise HTTPException(status_code=400, detail="La copia seleccionada esta vacia.")
        if source.suffix.lower() != ".db":
            raise HTTPException(status_code=400, detail="Debes seleccionar un archivo .db valido.")

        try:
            with sqlite3.connect(source) as conn:
                check_row = conn.execute("PRAGMA integrity_check").fetchone()
                check_value = str(check_row[0]).lower() if check_row and check_row[0] is not None else ""
                table_rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                table_names = sorted(str(row[0]) for row in table_rows)
        except sqlite3.Error as exc:
            _logger.exception("La copia seleccionada no se pudo abrir como SQLite: %s", exc)
            raise HTTPException(status_code=400, detail="La copia seleccionada no es una base SQLite valida.") from exc

        required_tables = {"categorias", "movimientos"}
        existing_tables_lower = {name.lower() for name in table_names}
        missing_tables = sorted(required_tables - existing_tables_lower)
        _logger.info(
            "Validacion de copia: integrity_check=%s tablas=%s missing=%s",
            check_value,
            ",".join(table_names),
            ",".join(missing_tables),
        )
        if check_value != "ok":
            raise HTTPException(status_code=400, detail="La copia seleccionada no es una base SQLite valida.")
        if missing_tables:
            raise HTTPException(status_code=400, detail="La copia seleccionada no tiene la estructura minima requerida.")

        db_path = Path(service.db.db_path)
        pre_restore_backups = get_data_dir() / "backups"
        _logger.info(
            "Restaurar copia: source_path=%s db_path=%s backups_dir=%s integrity_check=%s tablas=%s",
            source,
            db_path,
            pre_restore_backups,
            check_value,
            ",".join(table_names),
        )
        safety = service.restore_database_from_path(source, pre_restore_backups)
        _logger.info("Restaurar copia OK: backup_pre_restore=%s", safety)
        return {"ok": True, "safety_backup": str(safety)}
    except HTTPException:
        raise
    except (FileNotFoundError, ValueError) as exc:
        _logger.exception("Error restaurando copia de seguridad: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("Error restaurando copia de seguridad: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="No se pudo restaurar la copia de seguridad.",
        ) from exc


@app.get("/backup/download")
def download_backup(service: FinanceService = Depends(get_service)):
    try:
        ensure_app_data_initialized()
        source = Path(service.db.db_path)
        _logger.info("Solicitud de copia de seguridad. db_path=%s", source)
        if not source.exists():
            _logger.error("No existe la DB para copia de seguridad. db_path=%s", source)
            raise HTTPException(status_code=404, detail="No existe la base de datos local.")
        if not source.is_file():
            _logger.error("La ruta de DB no es un archivo. db_path=%s", source)
            raise HTTPException(status_code=500, detail="No se pudo obtener la copia de seguridad.")
        if source.stat().st_size <= 0:
            _logger.error("La DB esta vacia. db_path=%s", source)
            raise HTTPException(status_code=500, detail="No se pudo obtener la copia de seguridad.")

        filename = f"ScisoNomics_copia_seguridad_{datetime.now().strftime('%Y-%m-%d')}.db"
        return FileResponse(
            path=source,
            filename=filename,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        _logger.exception("Error generando copia de seguridad: %s", exc)
        raise HTTPException(status_code=500, detail="No se pudo obtener la copia de seguridad.") from exc


@app.get("/export/excel")
def export_excel(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None),
    desde: str | None = Query(default=None),
    hasta: str | None = Query(default=None),
    service: FinanceService = Depends(get_service),
):
    now = datetime.now()
    resolved_month = month if month is not None else now.month
    resolved_year = year if year is not None else now.year
    output = Path(gettempdir()) / "ScisoNomics" / "exports" / f"ScisoNomics_{now.strftime('%Y-%m-%d')}.xlsx"
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        if desde or hasta:
            if not desde or not hasta:
                raise HTTPException(status_code=400, detail="Debes indicar ambas fechas: desde y hasta.")
            try:
                from_dt = datetime.strptime(desde, "%Y-%m-%d")
                to_dt = datetime.strptime(hasta, "%Y-%m-%d")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Formato de fecha inválido. Usa YYYY-MM-DD.") from exc
            if from_dt > to_dt:
                raise HTTPException(status_code=400, detail="La fecha 'desde' no puede ser mayor que 'hasta'.")
            export_date_range_report(service, desde, hasta, output)
        else:
            export_monthly_report(service, resolved_month, resolved_year, output)
    except HTTPException:
        raise
    except Exception as exc:
        _logger.exception("Error exportando Excel (month=%s year=%s): %s", resolved_month, resolved_year, exc)
        raise HTTPException(status_code=500, detail="No se pudo generar el archivo Excel.") from exc
    return FileResponse(
        path=output,
        filename=output.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{output.name}"'},
    )


@app.get("/export/mensual")
def export_mensual(month: int = Query(..., ge=1, le=12), year: int = Query(...), service: FinanceService = Depends(get_service)):
    output = Path(mkdtemp(prefix="finanzas_export_")) / f"movimientos_{year}_{month:02d}.xlsx"
    export_monthly_report(service, month, year, output)
    return FileResponse(path=output, filename=output.name, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/export/anual")
def export_anual(year: int = Query(...), service: FinanceService = Depends(get_service)):
    output = Path(mkdtemp(prefix="finanzas_export_")) / f"finanzas_{year}.xlsx"
    export_yearly_report(service, year, output)
    return FileResponse(path=output, filename=output.name, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/export/filtrado")
def export_filtrado(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(...),
    tipo: Literal["todos", "ingreso", "gasto", "ahorro", "inversion"] = "todos",
    search: str = "",
    service: FinanceService = Depends(get_service),
):
    current_type = None if tipo in ("todos", "inversion") else tipo
    rows = service.list_movimientos(month, year, current_type)
    if tipo == "inversion":
        rows = [r for r in rows if "invers" in str(r.get("categoria", "")).lower()]
    term = search.strip().lower()
    if term:
        rows = [
            row
            for row in rows
            if term in str(row.get("descripcion", "")).lower()
            or term in str(row.get("categoria", "")).lower()
            or term in str(row.get("fecha", "")).lower()
        ]
    output = Path(mkdtemp(prefix="finanzas_export_")) / f"filtrado_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    export_filtered_movimientos(rows, output)
    return FileResponse(path=output, filename=output.name, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


def _backup_dir() -> Path:
    return WEB_DB_PATH.parent.parent / "backups"


@app.get("/backups")
def list_backups(service: FinanceService = Depends(get_service)):
    items = service.list_backups(_backup_dir())
    return {
        "folder": str(_backup_dir()),
        "count": len(items),
        "last_backup": items[0] if items else None,
        "items": items,
        "frequency": service.get_config_value("backup_frequency", "desactivado"),
    }


@app.post("/backups/create")
def create_backup(service: FinanceService = Depends(get_service)):
    created = service.backup_database(_backup_dir())
    return {"ok": True, "file": str(created), "name": created.name}


@app.post("/backups/restore")
def restore_backup_from_name(payload: BackupRestoreIn, service: FinanceService = Depends(get_service)):
    backup_file = _backup_dir() / payload.file_name
    safety = service.restore_database(backup_file, _backup_dir())
    return {"ok": True, "safety_backup": str(safety)}


@app.post("/backups/frequency")
def set_backup_frequency(payload: BackupFrequencyIn, service: FinanceService = Depends(get_service)):
    service.set_config_value("backup_frequency", payload.frecuencia)
    return {"ok": True}


@app.get("/metas")
def list_metas(service: FinanceService = Depends(get_service)):
    return service.list_metas_ahorro()


@app.post("/metas")
def create_meta(payload: MetaAhorroIn, service: FinanceService = Depends(get_service)):
    service.create_meta_ahorro(MetaAhorroInput(**payload.model_dump()))
    return {"ok": True}


@app.put("/metas/{meta_id}")
def update_meta(meta_id: int, payload: MetaAhorroIn, service: FinanceService = Depends(get_service)):
    service.update_meta_ahorro(meta_id, MetaAhorroInput(**payload.model_dump()))
    return {"ok": True}


@app.delete("/metas/{meta_id}")
def delete_meta(meta_id: int, service: FinanceService = Depends(get_service)):
    service.delete_meta_ahorro(meta_id)
    return {"ok": True}


@app.get("/tags")
def list_tags(service: FinanceService = Depends(get_service)):
    return service.list_tags()


@app.post("/tags")
def create_tag(payload: TagIn, service: FinanceService = Depends(get_service)):
    service.create_tag(TagInput(**payload.model_dump()))
    return {"ok": True}


@app.put("/tags/{tag_id}")
def update_tag(tag_id: int, payload: TagIn, service: FinanceService = Depends(get_service)):
    service.update_tag(tag_id, TagInput(**payload.model_dump()))
    return {"ok": True}


@app.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, service: FinanceService = Depends(get_service)):
    service.delete_tag(tag_id)
    return {"ok": True}


@app.get("/calendario")
def calendario(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None),
    mes: int | None = Query(default=None, ge=1, le=12),
    anio: int | None = Query(default=None),
    service: FinanceService = Depends(get_service),
):
    resolved_month = month if month is not None else mes
    resolved_year = year if year is not None else anio
    if resolved_month is None or resolved_year is None:
        raise HTTPException(status_code=400, detail="Debes indicar month/year o mes/anio.")
    return service.get_calendario_mensual(resolved_month, resolved_year)


@app.get("/reporte-mensual")
def reporte_mensual(
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None),
    mes: int | None = Query(default=None, ge=1, le=12),
    anio: int | None = Query(default=None),
    service: FinanceService = Depends(get_service),
):
    resolved_month = month if month is not None else mes
    resolved_year = year if year is not None else anio
    if resolved_month is None or resolved_year is None:
        raise HTTPException(status_code=400, detail="Debes indicar month/year o mes/anio.")

    raw = service.get_reporte_mensual_avanzado(resolved_month, resolved_year) or {}
    return {
        "month": resolved_month,
        "year": resolved_year,
        "ingresos": float(raw.get("ingresos_mes", 0) or 0),
        "gastos": float(raw.get("gastos_mes", 0) or 0),
        "ahorro": float(raw.get("ahorro_mes", 0) or 0),
        "inversiones": float(raw.get("inversiones_mes", 0) or 0),
        "balance_operativo": float(raw.get("balance_operativo", 0) or 0),
        "disponible_luego_ahorro": float(raw.get("disponible_luego_ahorro", 0) or 0),
        "top_categorias": list(raw.get("top_5_categorias_gasto", []) or []),
        "top_movimientos": list(raw.get("top_5_movimientos_gasto", []) or []),
        "evolucion_ultimos_6_meses": list(raw.get("evolucion_6_meses", []) or []),
        "presupuestos_excedidos": list(raw.get("presupuestos_excedidos", []) or []),
        "metas": list(raw.get("metas_activas", []) or []),
    }


@app.post("/import/preview")
async def import_preview(file: UploadFile = File(...)):
    name = (file.filename or "").lower()
    content = await file.read()
    if name.endswith(".csv"):
        text = content.decode("utf-8", errors="replace")
        rows = list(csv.DictReader(io.StringIO(text)))
    elif name.endswith(".xlsx"):
        wb = load_workbook(io.BytesIO(content), data_only=True)
        ws = wb.active
        values = list(ws.values)
        if not values:
            rows = []
        else:
            headers = [str(h or "").strip() for h in values[0]]
            rows = [{headers[i]: r[i] for i in range(len(headers))} for r in values[1:]]
    else:
        raise HTTPException(status_code=400, detail="Formato no soportado. Usa .csv o .xlsx")
    return {"rows_read": len(rows), "preview": rows[:50]}


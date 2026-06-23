from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from finance_app.db import Database  # noqa: E402
from finance_app.services import FinanceService, reset_current_owner_id, set_current_owner_id  # noqa: E402
from modern_app.backend.app.main import _sync_apply_remote_impl, sync_mark_rejected  # noqa: E402


OWNER = "owner-smoke"


def make_request(path: str, payload: dict[str, Any]) -> Request:
    body = json.dumps(payload).encode("utf-8")
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [(b"content-type", b"application/json")],
        },
        receive,
    )


def expect_http_exception(coro: Any, *, status_code: int, code: str, table: str | None = None, field: str | None = None) -> dict[str, Any]:
    try:
        asyncio.run(coro)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        assert exc.status_code == status_code, f"status inesperado: {exc.status_code} != {status_code}, detail={detail}"
        assert detail.get("code") == code, f"code inesperado: {detail}"
        if table is not None:
            assert detail.get("table") == table, f"table inesperada: {detail}"
        if field is not None:
            assert detail.get("field") == field, f"field inesperado: {detail}"
        return detail
    raise AssertionError(f"Se esperaba HTTPException {status_code}/{code} y la operación terminó OK")


def build_service(db_path: Path) -> FinanceService:
    db = Database(db_path=db_path)
    db.init_db()
    return FinanceService(db)


def run_as_owner(fn):
    token = set_current_owner_id(OWNER)
    try:
        return fn()
    finally:
        reset_current_owner_id(token)


def seed_categoria(service: FinanceService, *, sync_id: str, nombre: str, tipo: str, sync_status: str = "pending") -> None:
    now = "2026-06-22T00:00:00Z"
    with service.db.connect() as conn:
        conn.execute(
            """
            INSERT INTO categorias (
                nombre, tipo, owner_user_id, sync_id, created_at, updated_at, sync_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (nombre, tipo, OWNER, sync_id, now, now, sync_status),
        )


def seed_tag(
    service: FinanceService,
    *,
    nombre: str,
    sync_id: str | None = None,
    color: str | None = None,
    sync_status: str = "pending",
) -> int:
    now = "2026-06-22T00:00:00Z"
    with service.db.connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO tags (
                nombre, color, owner_user_id, sync_id, created_at, updated_at, sync_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (nombre, color, OWNER, sync_id, now, now, sync_status),
        )
        return int(cursor.lastrowid)


def seed_movimiento(
    service: FinanceService,
    *,
    sync_id: str,
    categoria_id: int,
    descripcion: str = "Movimiento",
    monto: float = 10.0,
    tipo: str = "gasto",
    fecha: str = "2026-06-22",
    sync_status: str = "pending",
) -> int:
    now = "2026-06-22T00:00:00Z"
    with service.db.connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO movimientos (
                fecha, tipo, categoria_id, descripcion, monto, owner_user_id, sync_id, created_at, updated_at, sync_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (fecha, tipo, categoria_id, descripcion, monto, OWNER, sync_id, now, now, sync_status),
        )
        return int(cursor.lastrowid)


def seed_movimiento_tag(
    service: FinanceService,
    *,
    movimiento_id: int,
    tag_id: int,
    sync_id: str | None = None,
    sync_status: str = "pending",
) -> int:
    now = "2026-06-22T00:00:00Z"
    with service.db.connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO movimiento_tags (
                movimiento_id, tag_id, owner_user_id, sync_id, created_at, updated_at, sync_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (movimiento_id, tag_id, OWNER, sync_id, now, now, sync_status),
        )
        return int(cursor.lastrowid)


def test_apply_remote_invalid_categoria_missing_sync_id(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"categorias": [{"nombre": "Comida", "tipo": "gasto"}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="categorias",
        field="sync_id",
    )


def test_apply_remote_invalid_categoria_missing_nombre(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"categorias": [{"sync_id": "cat-a", "nombre": "", "tipo": "gasto"}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="categorias",
        field="nombre",
    )


def test_apply_remote_invalid_categoria_missing_tipo(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"categorias": [{"sync_id": "cat-b", "nombre": "Comida", "tipo": ""}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="categorias",
        field="tipo",
    )


def test_apply_remote_invalid_movimiento_missing_sync_id(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"movimientos": [{"tipo": "gasto", "monto": 10, "fecha": "2026-06-22"}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="movimientos",
        field="sync_id",
    )


def test_apply_remote_invalid_presupuesto_missing_sync_id(service: FinanceService) -> None:
    categoria_id = seed_categoria_and_get_id(service, sync_id="cat-presupuesto", nombre="Comida", tipo="gasto")
    with service.db.connect() as conn:
        categoria = conn.execute(
            "SELECT sync_id FROM categorias WHERE id = ? AND owner_user_id = ?",
            (categoria_id, OWNER),
        ).fetchone()
    request = make_request(
        "/sync/apply-remote",
        {"presupuestos": [{"categoria_sync_id": str(categoria["sync_id"]), "mes": 6, "anio": 2026, "monto": 1000}]},
    )
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="presupuestos",
        field="sync_id",
    )


def seed_categoria_and_get_id(service: FinanceService, *, sync_id: str, nombre: str, tipo: str, sync_status: str = "pending") -> int:
    now = "2026-06-22T00:00:00Z"
    with service.db.connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO categorias (
                nombre, tipo, owner_user_id, sync_id, created_at, updated_at, sync_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (nombre, tipo, OWNER, sync_id, now, now, sync_status),
        )
        return int(cursor.lastrowid)


def test_apply_remote_invalid_tag_missing_sync_id(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"tags": [{"nombre": "Trabajo", "color": "#fff"}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="tags",
        field="sync_id",
    )


def test_apply_remote_invalid_tag_missing_nombre(service: FinanceService) -> None:
    request = make_request("/sync/apply-remote", {"tags": [{"sync_id": "tag-a", "nombre": "", "color": "#fff"}]})
    expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=422,
        code="local_apply_invalid_payload",
        table="tags",
        field="nombre",
    )


def test_apply_remote_tag_links_sync_id_to_existing_local_tag(service: FinanceService) -> None:
    local_tag_id = seed_tag(service, nombre="Trabajo", sync_id=None, color="#123456", sync_status="pending")
    request = make_request(
        "/sync/apply-remote",
        {"tags": [{"sync_id": "tag-remote", "nombre": "Trabajo", "color": "#abcdef", "updated_at": "2026-06-22T10:00:00Z"}]},
    )
    result = asyncio.run(_sync_apply_remote_impl(request, service))
    assert result["ok"] is True, result
    with service.db.connect() as conn:
        row = conn.execute(
            "SELECT id, sync_id FROM tags WHERE owner_user_id = ? AND nombre = ?",
            (OWNER, "Trabajo"),
        ).fetchone()
    assert row is not None, "No se encontro el tag local"
    assert int(row["id"]) == local_tag_id, row
    assert str(row["sync_id"]) == "tag-remote", row


def test_apply_remote_tag_sync_id_conflict(service: FinanceService) -> None:
    seed_tag(service, nombre="Trabajo", sync_id=None)
    seed_tag(service, nombre="Delivery", sync_id="tag-conflict")
    request = make_request(
        "/sync/apply-remote",
        {"tags": [{"sync_id": "tag-conflict", "nombre": "Trabajo", "color": "#abcdef", "updated_at": "2026-06-22T10:00:00Z"}]},
    )
    detail = expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=409,
        code="local_apply_constraint",
        table="tags",
    )
    assert detail.get("constraint") == "sync_id", detail


def test_apply_remote_movement_tag_links_sync_id_to_existing_relation(service: FinanceService) -> None:
    categoria_id = seed_categoria_and_get_id(service, sync_id="cat-mt", nombre="Comida", tipo="gasto")
    movimiento_id = seed_movimiento(service, sync_id="mov-1", categoria_id=categoria_id)
    tag_id = seed_tag(service, nombre="Trabajo", sync_id="tag-1")
    relation_id = seed_movimiento_tag(service, movimiento_id=movimiento_id, tag_id=tag_id, sync_id=None)
    request = make_request(
        "/sync/apply-remote",
        {"movimiento_tags": [{"sync_id": "mt-remote", "movimiento_sync_id": "mov-1", "tag_sync_id": "tag-1", "updated_at": "2026-06-22T10:00:00Z"}]},
    )
    result = asyncio.run(_sync_apply_remote_impl(request, service))
    assert result["ok"] is True, result
    with service.db.connect() as conn:
        row = conn.execute(
            "SELECT rowid AS _rowid, sync_id FROM movimiento_tags WHERE owner_user_id = ? AND movimiento_id = ? AND tag_id = ?",
            (OWNER, movimiento_id, tag_id),
        ).fetchone()
    assert row is not None, "No se encontro la relacion local"
    assert int(row["_rowid"]) == relation_id, row
    assert str(row["sync_id"]) == "mt-remote", row


def test_apply_remote_movement_tag_sync_id_conflict(service: FinanceService) -> None:
    categoria_id = seed_categoria_and_get_id(service, sync_id="cat-mt-conf", nombre="Comida", tipo="gasto")
    movimiento_a = seed_movimiento(service, sync_id="mov-a", categoria_id=categoria_id)
    movimiento_b = seed_movimiento(service, sync_id="mov-b", categoria_id=categoria_id)
    tag_a = seed_tag(service, nombre="Trabajo", sync_id="tag-a")
    tag_b = seed_tag(service, nombre="Delivery", sync_id="tag-b")
    seed_movimiento_tag(service, movimiento_id=movimiento_a, tag_id=tag_a, sync_id="mt-conflict")
    seed_movimiento_tag(service, movimiento_id=movimiento_b, tag_id=tag_b, sync_id=None)
    request = make_request(
        "/sync/apply-remote",
        {"movimiento_tags": [{"sync_id": "mt-conflict", "movimiento_sync_id": "mov-b", "tag_sync_id": "tag-b", "updated_at": "2026-06-22T10:00:00Z"}]},
    )
    detail = expect_http_exception(
        _sync_apply_remote_impl(request, service),
        status_code=409,
        code="local_apply_constraint",
        table="movimiento_tags",
    )
    assert detail.get("constraint") == "sync_id", detail


def test_mark_rejected_item_not_dict(service: FinanceService) -> None:
    request = make_request("/sync/mark-rejected", {"rejected": ["bad-item"]})
    expect_http_exception(
        sync_mark_rejected(request, service),
        status_code=422,
        code="local_rejection_invalid_payload",
    )


def test_mark_rejected_missing_table(service: FinanceService) -> None:
    request = make_request("/sync/mark-rejected", {"rejected": [{"sync_id": "cat-missing-table"}]})
    expect_http_exception(
        sync_mark_rejected(request, service),
        status_code=422,
        code="local_rejection_invalid_payload",
        field="table",
    )


def test_mark_rejected_missing_sync_id(service: FinanceService) -> None:
    request = make_request("/sync/mark-rejected", {"rejected": [{"entity": "categorias"}]})
    expect_http_exception(
        sync_mark_rejected(request, service),
        status_code=422,
        code="local_rejection_invalid_payload",
        table="categorias",
        field="sync_id",
    )


def test_mark_rejected_unsupported_table(service: FinanceService) -> None:
    request = make_request("/sync/mark-rejected", {"rejected": [{"entity": "tabla_fantasma", "sync_id": "ghost-1"}]})
    expect_http_exception(
        sync_mark_rejected(request, service),
        status_code=422,
        code="local_rejection_unsupported_table",
        table="tabla_fantasma",
    )


def test_mark_rejected_target_not_found(service: FinanceService) -> None:
    request = make_request("/sync/mark-rejected", {"rejected": [{"entity": "categorias", "sync_id": "cat-inexistente"}]})
    expect_http_exception(
        sync_mark_rejected(request, service),
        status_code=409,
        code="local_rejection_target_not_found",
        table="categorias",
    )


def test_mark_rejected_idempotent(service: FinanceService) -> None:
    seed_categoria(service, sync_id="cat-sync-error", nombre="Comida", tipo="gasto", sync_status="sync_error")
    request = make_request(
        "/sync/mark-rejected",
        {"rejected": [{"entity": "categorias", "sync_id": "cat-sync-error", "code": "invalid_payload", "message": "Registro inválido"}]},
    )
    result = asyncio.run(sync_mark_rejected(request, service))
    assert result["ok"] is True, result
    assert int(result["rejected_total"]) >= 1, result
    with service.db.connect() as conn:
        row = conn.execute(
            "SELECT sync_status FROM categorias WHERE sync_id = ? AND owner_user_id = ?",
            ("cat-sync-error", OWNER),
        ).fetchone()
    assert row is not None, "El registro idempotente desapareció"
    assert str(row["sync_status"]) == "sync_error", row


def main() -> None:
    with TemporaryDirectory(prefix="scisonomics-smoke-") as tmp:
        tests = [
            ("A categorias sin sync_id", test_apply_remote_invalid_categoria_missing_sync_id),
            ("B categorias sin nombre", test_apply_remote_invalid_categoria_missing_nombre),
            ("C categorias sin tipo", test_apply_remote_invalid_categoria_missing_tipo),
            ("D movimientos sin sync_id", test_apply_remote_invalid_movimiento_missing_sync_id),
            ("E presupuestos sin sync_id", test_apply_remote_invalid_presupuesto_missing_sync_id),
            ("F tags sin sync_id", test_apply_remote_invalid_tag_missing_sync_id),
            ("G tags sin nombre", test_apply_remote_invalid_tag_missing_nombre),
            ("H tag equivalente vincula sync_id", test_apply_remote_tag_links_sync_id_to_existing_local_tag),
            ("I tag sync_id conflictivo", test_apply_remote_tag_sync_id_conflict),
            ("J movimiento_tags vincula sync_id", test_apply_remote_movement_tag_links_sync_id_to_existing_relation),
            ("K movimiento_tags sync_id conflictivo", test_apply_remote_movement_tag_sync_id_conflict),
            ("L mark-rejected item no dict", test_mark_rejected_item_not_dict),
            ("M mark-rejected sin table", test_mark_rejected_missing_table),
            ("N mark-rejected sin sync_id", test_mark_rejected_missing_sync_id),
            ("O mark-rejected tabla no soportada", test_mark_rejected_unsupported_table),
            ("P mark-rejected target inexistente", test_mark_rejected_target_not_found),
            ("Q mark-rejected idempotente", test_mark_rejected_idempotent),
        ]

        for index, (label, test_fn) in enumerate(tests, start=1):
            db_path = Path(tmp) / f"smoke_{index}.db"
            service = build_service(db_path)
            run_as_owner(lambda fn=test_fn: fn(service))
            print(f"[ok] {label}")

    print("smoke_sync_validation: OK")


if __name__ == "__main__":
    main()

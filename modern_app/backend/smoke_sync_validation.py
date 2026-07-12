from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi import HTTPException
from starlette.requests import Request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from finance_app.db import Database  # noqa: E402
from finance_app.services import FinanceService, reset_current_owner_id, set_current_owner_id  # noqa: E402
from modern_app.backend.app import main as backend_main  # noqa: E402
from modern_app.backend.app.main import (  # noqa: E402
    _config_set,
    _require_premium_feature,
    _sync_apply_remote_impl,
    cache_local_billing_entitlements,
    sync_mark_rejected,
    sync_mark_synced,
)


OWNER = "owner-smoke"
TEST_ENTITLEMENT_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
backend_main.ENTITLEMENTS_PUBLIC_KEY_PEM = TEST_ENTITLEMENT_PRIVATE_KEY.public_key().public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo,
).decode("ascii")


def make_request(path: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> Request:
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
            "headers": [
                (key.lower().encode("ascii"), value.encode("utf-8"))
                for key, value in {"content-type": "application/json", **(headers or {})}.items()
            ],
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
    backend_main.WEB_DB_PATH = db_path
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


def test_mark_synced_payload_not_list(service: FinanceService) -> None:
    request = make_request("/sync/mark-synced", {"categorias": 7})
    expect_http_exception(
        sync_mark_synced(request, service),
        status_code=422,
        code="local_mark_synced_invalid_payload",
        table="categorias",
        field="categorias",
    )


def test_mark_synced_string_instead_of_list(service: FinanceService) -> None:
    request = make_request("/sync/mark-synced", {"categorias": "cat-a"})
    expect_http_exception(
        sync_mark_synced(request, service),
        status_code=422,
        code="local_mark_synced_invalid_payload",
        table="categorias",
        field="categorias",
    )


def test_mark_synced_target_not_found(service: FinanceService) -> None:
    request = make_request("/sync/mark-synced", {"categorias": ["cat-inexistente"]})
    expect_http_exception(
        sync_mark_synced(request, service),
        status_code=409,
        code="local_mark_synced_target_not_found",
        table="categorias",
    )


def test_mark_synced_idempotent(service: FinanceService) -> None:
    seed_categoria(service, sync_id="cat-synced", nombre="Comida", tipo="gasto", sync_status="synced")
    result = asyncio.run(sync_mark_synced(make_request("/sync/mark-synced", {"categorias": ["cat-synced"]}), service))
    assert result["ok"] is True, result
    assert result["marked"]["categorias"] == 0, result
    assert result["idempotent"]["categorias"] == 1, result


def test_mark_synced_updates_pending(service: FinanceService) -> None:
    seed_categoria(service, sync_id="cat-pending", nombre="Servicios", tipo="gasto", sync_status="pending")
    result = asyncio.run(sync_mark_synced(make_request("/sync/mark-synced", {"categorias": ["cat-pending"]}), service))
    assert result["ok"] is True, result
    assert result["marked"]["categorias"] == 1, result
    assert result["idempotent"]["categorias"] == 0, result
    with service.db.connect() as conn:
        row = conn.execute(
            "SELECT sync_status FROM categorias WHERE owner_user_id = ? AND sync_id = ?",
            (OWNER, "cat-pending"),
        ).fetchone()
    assert row is not None and row["sync_status"] == "synced", row


def _simple_remote_payload(table: str, **overrides: Any) -> dict[str, Any]:
    items: dict[str, dict[str, Any]] = {
        "presupuestos": {"sync_id": "budget-1", "categoria_sync_id": "cat-simple", "mes": 6, "anio": 2026, "monto": 1000},
        "gastos_fijos": {
            "sync_id": "fixed-1", "categoria_sync_id": "cat-simple", "descripcion": "Servicio",
            "monto": 1000, "dia_vencimiento": 10, "activo": 1,
        },
        "gastos_programados": {
            "sync_id": "planned-1", "categoria_sync_id": "cat-simple", "descripcion": "Pago",
            "monto_estimado": 1000, "fecha_vencimiento": "2026-07-20", "estado": "pendiente",
            "es_recurrente": 0, "frecuencia": None,
        },
        "metas_ahorro": {
            "sync_id": "goal-1", "nombre": "Viaje", "monto_objetivo": 1000, "monto_inicial": 0,
            "fecha_objetivo": None, "descripcion": "", "estado": "activa",
        },
    }
    item = {**items[table], **overrides}
    return {table: [item]}


def _expect_invalid_simple_remote(service: FinanceService, table: str, field: str, **overrides: Any) -> None:
    if table != "metas_ahorro":
        seed_categoria(service, sync_id="cat-simple", nombre="Comida", tipo="gasto")
    expect_http_exception(
        _sync_apply_remote_impl(make_request("/sync/apply-remote", _simple_remote_payload(table, **overrides)), service),
        status_code=422,
        code="local_apply_invalid_payload",
        table=table,
        field=field,
    )


def test_invalid_presupuesto_month(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "presupuestos", "mes", mes=99)


def test_invalid_presupuesto_amount(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "presupuestos", "monto", monto=-1)


def test_invalid_gasto_fijo_active(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "gastos_fijos", "activo", activo=7)


def test_invalid_gasto_fijo_due_day(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "gastos_fijos", "dia_vencimiento", dia_vencimiento=99)


def test_invalid_gasto_programado_state(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "gastos_programados", "estado", estado="desconocido")


def test_invalid_meta_state(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "metas_ahorro", "estado", estado="desconocido")


def test_invalid_meta_target_amount(service: FinanceService) -> None:
    _expect_invalid_simple_remote(service, "metas_ahorro", "monto_objetivo", monto_objetivo=-1)


def test_valid_simple_remote_applies(service: FinanceService) -> None:
    seed_categoria(service, sync_id="cat-simple", nombre="Comida", tipo="gasto")
    result = asyncio.run(
        _sync_apply_remote_impl(make_request("/sync/apply-remote", _simple_remote_payload("presupuestos")), service)
    )
    assert result["ok"] is True, result
    with service.db.connect() as conn:
        row = conn.execute(
            "SELECT sync_status, mes, anio, monto FROM presupuestos WHERE owner_user_id = ? AND sync_id = ?",
            (OWNER, "budget-1"),
        ).fetchone()
    assert row is not None, "El presupuesto valido no fue aplicado"
    assert row["sync_status"] == "synced" and row["mes"] == 6 and row["anio"] == 2026, row


def seed_entitlements(service: FinanceService, *, payload: dict[str, Any]) -> None:
    with service.db.connect() as conn:
        _config_set(conn, f"cloud_entitlements:{OWNER}", json.dumps(payload))


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def signed_entitlement(
    *,
    owner: str = OWNER,
    plan: str = "premium",
    status: str = "active",
    features: dict[str, bool] | None = None,
    expires_in: int = 3600,
) -> str:
    now = int(time.time())
    claims = {
        "type": "scisonomics_entitlement",
        "user_id": owner,
        "plan": plan,
        "status": status,
        "features": features or {"budgets": True, "saving_goals": True, "fixed_expenses": True, "planning": True},
        "subscription_expires_at": None,
        "iat": now - 5,
        "exp": now + expires_in,
    }
    header = {"alg": "RS256", "typ": "JWT"}
    signing_input = ".".join(
        [
            _b64url(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")),
            _b64url(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8")),
        ]
    )
    signature = TEST_ENTITLEMENT_PRIVATE_KEY.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{_b64url(signature)}"


def seed_signed_entitlement(service: FinanceService, token: str, **metadata: Any) -> None:
    seed_entitlements(service, payload={
        "plan": metadata.get("plan", "premium"),
        "status": metadata.get("status", "active"),
        "features": metadata.get("features", {"budgets": True, "saving_goals": True, "fixed_expenses": True, "planning": True}),
        "source": "cloud_verified",
        "last_verified_at": "2999-01-01T00:00:00Z",
        "expires_at": None,
        "user_id": metadata.get("user_id", OWNER),
        "entitlement_token": token,
    })


def expect_premium_required(feature: str) -> None:
    try:
        _require_premium_feature(feature)
    except Exception as exc:
        assert getattr(exc, "code", None) == "premium_required", str(exc)
        return
    raise AssertionError("Se esperaba premium_required")


def test_premium_entitlements_free_denied(service: FinanceService) -> None:
    seed_signed_entitlement(service, signed_entitlement(plan="free", features={"budgets": False, "saving_goals": False, "fixed_expenses": False, "planning": False}))
    expect_premium_required("budgets")


def test_premium_entitlements_unverified_cache_denied(service: FinanceService) -> None:
    seed_entitlements(service, payload={
        "plan": "premium",
        "status": "active",
        "features": {"budgets": True, "saving_goals": True, "fixed_expenses": True, "planning": True},
        "source": "unverified_ui_cache",
        "last_verified_at": "2999-01-01T00:00:00Z",
        "expires_at": None,
    })
    expect_premium_required("budgets")


def test_premium_entitlements_verified_within_ttl_allowed(service: FinanceService) -> None:
    seed_signed_entitlement(service, signed_entitlement())
    _require_premium_feature("budgets")


def test_premium_entitlements_expired_denied(service: FinanceService) -> None:
    seed_signed_entitlement(service, signed_entitlement(expires_in=-1))
    expect_premium_required("budgets")


def test_premium_entitlements_stale_last_verified_denied(service: FinanceService) -> None:
    seed_signed_entitlement(service, signed_entitlement(), last_verified_at="2000-01-01T00:00:00Z")
    _require_premium_feature("budgets")


def test_premium_entitlements_inactive_status_denied(service: FinanceService) -> None:
    for status in ("past_due", "canceled", "expired"):
        seed_signed_entitlement(service, signed_entitlement(status=status))
        expect_premium_required("budgets")


def test_premium_tampered_token_denied(service: FinanceService) -> None:
    token = signed_entitlement()
    header, payload, signature = token.split(".", 2)
    payload = ("A" if payload[0] != "A" else "B") + payload[1:]
    seed_signed_entitlement(service, f"{header}.{payload}.{signature}")
    expect_premium_required("budgets")


def test_premium_owner_mismatch_denied(service: FinanceService) -> None:
    seed_signed_entitlement(service, signed_entitlement(owner="owner-other"))
    expect_premium_required("budgets")


def test_premium_feature_disabled_denied(service: FinanceService) -> None:
    seed_signed_entitlement(
        service,
        signed_entitlement(features={"budgets": False, "saving_goals": True, "fixed_expenses": True, "planning": True}),
    )
    expect_premium_required("budgets")


def test_parallel_metadata_cannot_override_signed_free(service: FinanceService) -> None:
    seed_signed_entitlement(
        service,
        signed_entitlement(plan="free", features={"budgets": False, "saving_goals": False, "fixed_expenses": False, "planning": False}),
        plan="premium",
        features={"budgets": True, "saving_goals": True, "fixed_expenses": True, "planning": True},
    )
    expect_premium_required("budgets")


def test_entitlement_cache_owner_mismatch(service: FinanceService) -> None:
    original_fetch = backend_main._fetch_cloud_entitlements_verified
    original_initialize = backend_main.ensure_app_data_initialized
    backend_main._fetch_cloud_entitlements_verified = lambda _token: {
        "user_id": "owner-other",
        "plan": "premium",
        "status": "active",
        "features": {"budgets": True, "saving_goals": True, "fixed_expenses": True, "planning": True},
        "expires_at": None,
        "entitlement_token": signed_entitlement(owner="owner-other"),
    }
    backend_main.ensure_app_data_initialized = lambda: service.db
    try:
        expect_http_exception(
            cache_local_billing_entitlements(
                make_request("/billing/entitlements/cache", {"refresh": True}, {"authorization": "Bearer test-access"}),
                service,
            ),
            status_code=403,
            code="entitlement_owner_mismatch",
        )
    finally:
        backend_main._fetch_cloud_entitlements_verified = original_fetch
        backend_main.ensure_app_data_initialized = original_initialize
    with service.db.connect() as conn:
        assert conn.execute("SELECT value FROM app_config WHERE key = ?", (f"cloud_entitlements:{OWNER}",)).fetchone() is None


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
            ("R mark-synced payload no-list", test_mark_synced_payload_not_list),
            ("S mark-synced string", test_mark_synced_string_instead_of_list),
            ("T mark-synced target inexistente", test_mark_synced_target_not_found),
            ("U mark-synced idempotente", test_mark_synced_idempotent),
            ("V mark-synced actualiza pending", test_mark_synced_updates_pending),
            ("W presupuesto mes invalido", test_invalid_presupuesto_month),
            ("X presupuesto monto invalido", test_invalid_presupuesto_amount),
            ("Y gasto fijo activo invalido", test_invalid_gasto_fijo_active),
            ("Z gasto fijo vencimiento invalido", test_invalid_gasto_fijo_due_day),
            ("AA gasto programado estado invalido", test_invalid_gasto_programado_state),
            ("AB meta estado invalido", test_invalid_meta_state),
            ("AC meta monto invalido", test_invalid_meta_target_amount),
            ("AD simple remoto valido", test_valid_simple_remote_applies),
            ("AE premium free denied", test_premium_entitlements_free_denied),
            ("AF premium unverified denied", test_premium_entitlements_unverified_cache_denied),
            ("AG premium verified allowed", test_premium_entitlements_verified_within_ttl_allowed),
            ("AH premium expires_at denied", test_premium_entitlements_expired_denied),
            ("AI premium offline signed allowed", test_premium_entitlements_stale_last_verified_denied),
            ("AJ premium inactive denied", test_premium_entitlements_inactive_status_denied),
            ("AK premium tampered denied", test_premium_tampered_token_denied),
            ("AL premium owner mismatch denied", test_premium_owner_mismatch_denied),
            ("AM premium feature disabled", test_premium_feature_disabled_denied),
            ("AN metadata cannot override token", test_parallel_metadata_cannot_override_signed_free),
            ("AO cache owner mismatch", test_entitlement_cache_owner_mismatch),
        ]

        for index, (label, test_fn) in enumerate(tests, start=1):
            db_path = Path(tmp) / f"smoke_{index}.db"
            service = build_service(db_path)
            run_as_owner(lambda fn=test_fn: fn(service))
            print(f"[ok] {label}")

    print("smoke_sync_validation: OK")


if __name__ == "__main__":
    main()

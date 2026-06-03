from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import logging
import os
import re
import secrets
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .auth import create_access_token, decode_access_token, get_jwt_secret, hash_password, verify_password
from .db import connect, get_database_engine, init_db
from .schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut


app = FastAPI(title="ScisoNomics Cloud Auth API", version="3.1.0")
_logger = logging.getLogger("scisonomics.cloud")
SYNC_CONTRACT_VERSION = "3.1.0"
CLOUD_SCHEMA_VERSION = "cloud-sync-v1"
CLOUD_SCHEMA_REVISION = 2


def allowed_origins() -> list[str]:
    raw = os.getenv("SCISONOMICS_ALLOWED_ORIGINS", "").strip()
    env = os.getenv("SCISONOMICS_ENV", "development").strip().lower()
    if not raw:
        if env == "production":
            raise RuntimeError("SCISONOMICS_ALLOWED_ORIGINS es obligatorio en produccion.")
        return ["http://127.0.0.1:3000", "http://localhost:3000", "tauri://localhost", "https://tauri.localhost"]
    if raw == "*":
        if env == "production":
            raise RuntimeError("SCISONOMICS_ALLOWED_ORIGINS no puede ser '*' en produccion.")
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]

_allowed_origins = allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=_allowed_origins != ["*"],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Scisonomics-Owner-Id"],
)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.on_event("startup")
def startup() -> None:
    get_jwt_secret()
    init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def normalize_email(email: str) -> str:
    return email.strip().lower()


def mask_email(email: str) -> str:
    normalized = normalize_email(email)
    if "@" not in normalized:
        return "***"
    local, domain = normalized.split("@", 1)
    if not local:
        return f"***@{domain}"
    # Conservar contexto minimo para soporte sin registrar el email completo.
    return f"{local[:3]}***@{domain}"


def short_identifier(value: str) -> str:
    clean = str(value or "").strip()
    if len(clean) <= 8:
        return "***"
    return f"{clean[:4]}...{clean[-4:]}"


def validate_credentials(email: str, password: str) -> str:
    normalized_email = normalize_email(email)
    if not EMAIL_RE.match(normalized_email):
        raise HTTPException(status_code=422, detail="Ingresa un email valido.")
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="La contrasena debe tener al menos 8 caracteres.")
    return normalized_email


def _require_debug_endpoints_enabled() -> None:
    enabled = os.getenv("SCISONOMICS_ENABLE_DEBUG_ENDPOINTS", "").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        raise HTTPException(status_code=404, detail="Not Found")


def row_to_user(row) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _google_config() -> tuple[str, str, str]:
    client_id = os.getenv("SCISONOMICS_GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("SCISONOMICS_GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("SCISONOMICS_GOOGLE_REDIRECT_URI", "").strip()
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(status_code=503, detail="Google Login no esta configurado.")
    return client_id, client_secret, redirect_uri


def _cleanup_google_login_requests(conn, now: str) -> None:
    conn.execute("DELETE FROM google_login_requests WHERE expires_at < ?", (now,))


def _http_json(url: str, *, method: str = "GET", data: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    encoded = None
    request_headers = dict(headers or {})
    if data is not None:
        encoded = urlencode(data).encode("utf-8")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = UrlRequest(url, data=encoded, headers=request_headers, method=method)
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _exchange_google_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> dict[str, Any]:
    token_response = _http_json(
        "https://oauth2.googleapis.com/token",
        method="POST",
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    access_token = token_response.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail="Google no devolvio un token valido.")
    return _http_json(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
    )


def _find_user_by_normalized_email(conn, email: str):
    normalized = normalize_email(email)
    return conn.execute(
        """
        SELECT id, email, display_name, created_at, updated_at, google_sub
        FROM users
        WHERE LOWER(TRIM(email)) = ?
        ORDER BY CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
        """,
        (normalized,),
    ).fetchone()


def _find_or_create_google_user(conn, profile: dict[str, Any], now: str) -> UserOut:
    google_sub = str(profile.get("sub") or "").strip()
    original_email = str(profile.get("email") or "")
    email = normalize_email(original_email)
    display_name = str(profile.get("name") or "").strip() or None
    avatar_url = str(profile.get("picture") or "").strip() or None
    if not google_sub or not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Google no devolvio un perfil valido.")
    _logger.info("[google-auth] callback profile google_sub=%s email=%s", short_identifier(google_sub), mask_email(email))

    google_row = conn.execute(
        "SELECT id, email, display_name, created_at, updated_at, google_sub FROM users WHERE google_sub = ?",
        (google_sub,),
    ).fetchone()
    email_row = _find_user_by_normalized_email(conn, email)
    if google_row and email_row and google_row["id"] != email_row["id"]:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=relink_existing_email user_id=%s duplicate_user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            True,
            True,
            short_identifier(email_row["id"]),
            short_identifier(google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET google_sub = NULL, updated_at = ?
            WHERE id = ?
            """,
            (now, google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, google_sub = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, auth_provider = 'google', updated_at = ?
            WHERE id = ?
            """,
            (email, google_sub, display_name, avatar_url, now, email_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (email_row["id"],)).fetchone()
        return row_to_user(updated)

    if google_row:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=use_google_sub user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            True,
            bool(email_row),
            short_identifier(google_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, display_name = COALESCE(?, display_name), avatar_url = ?, auth_provider = 'google', updated_at = ?
            WHERE id = ?
            """,
            (email, display_name, avatar_url, now, google_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (google_row["id"],)).fetchone()
        return row_to_user(updated)

    if email_row:
        _logger.info(
            "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=link_existing_email user_id=%s",
            short_identifier(google_sub),
            mask_email(email),
            False,
            True,
            short_identifier(email_row["id"]),
        )
        conn.execute(
            """
            UPDATE users
            SET email = ?, google_sub = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, auth_provider = 'google', updated_at = ?
            WHERE id = ?
            """,
            (email, google_sub, display_name, avatar_url, now, email_row["id"]),
        )
        updated = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (email_row["id"],)).fetchone()
        return row_to_user(updated)

    user_id = str(uuid4())
    _logger.info(
        "[google-auth] google_sub=%s email=%s found_by_google_sub=%s found_by_email=%s action=create_new_user user_id=%s",
        short_identifier(google_sub),
        mask_email(email),
        False,
        False,
        short_identifier(user_id),
    )
    conn.execute(
        """
        INSERT INTO users (id, email, password_hash, display_name, google_sub, avatar_url, auth_provider, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?)
        """,
        (user_id, email, "", display_name, google_sub, avatar_url, now, now),
    )
    created = conn.execute("SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?", (user_id,)).fetchone()
    return row_to_user(created)


def parse_sync_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        try:
            return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None


SYNC_TABLES = ("categorias", "tags", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos", "movimientos", "movimiento_tags")

SYNC_CONFIG: dict[str, dict[str, Any]] = {
    "categorias": {
        "table": "cloud_categorias",
        "required": ("nombre", "tipo"),
        "fields": ("nombre", "tipo", "color", "icono"),
        "order": "nombre",
    },
    "movimientos": {
        "table": "cloud_movimientos",
        "required": ("tipo", "fecha"),
        "fields": ("tipo", "monto", "descripcion", "categoria_id", "categoria_sync_id", "fecha"),
        "order": "fecha DESC, id DESC",
    },
    "metas_ahorro": {
        "table": "cloud_metas_ahorro",
        "required": ("nombre",),
        "fields": ("nombre", "monto_objetivo", "monto_inicial", "fecha_objetivo", "descripcion", "estado"),
        "order": "created_at DESC, id DESC",
    },
    "gastos_programados": {
        "table": "cloud_gastos_programados",
        "required": ("descripcion",),
        "fields": ("descripcion", "categoria_sync_id", "monto_estimado", "fecha_vencimiento", "estado", "es_recurrente", "frecuencia"),
        "order": "fecha_vencimiento ASC, id DESC",
    },
    "gastos_fijos": {
        "table": "cloud_gastos_fijos",
        "required": ("descripcion",),
        "fields": ("descripcion", "categoria_sync_id", "monto", "dia_vencimiento", "activo"),
        "order": "dia_vencimiento ASC, id DESC",
    },
    "presupuestos": {
        "table": "cloud_presupuestos",
        "required": ("mes", "anio"),
        "fields": ("categoria_sync_id", "mes", "anio", "monto"),
        "order": "anio DESC, mes DESC, id DESC",
    },
    "tags": {
        "table": "cloud_tags",
        "required": ("nombre",),
        "fields": ("nombre", "color"),
        "order": "nombre, id DESC",
    },
    "movimiento_tags": {
        "table": "cloud_movimiento_tags",
        "required": ("movimiento_sync_id", "tag_sync_id"),
        "fields": ("movimiento_sync_id", "tag_sync_id"),
        "order": "id DESC",
    },
}

RejectedSyncItem = dict[str, str]


def _valid_sync_item(item: dict[str, Any], config: dict[str, Any]) -> bool:
    sync_id = str(item.get("sync_id") or "").strip()
    if not sync_id:
        return False
    return all(item.get(field) not in (None, "") for field in config["required"])


def _rejected_item(entity: str, sync_id: str | None, code: str, message: str) -> RejectedSyncItem:
    return {
        "entity": entity,
        "sync_id": str(sync_id or "").strip(),
        "code": code,
        "message": message,
    }


def _push_table(
    conn,
    user_id: str,
    key: str,
    items: list[dict[str, Any]],
    now: str,
    device_id: str | None,
    device_name: str | None,
) -> tuple[list[str], list[RejectedSyncItem], int]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = list(config["fields"])
    accepted: list[str] = []
    rejected: list[RejectedSyncItem] = []
    conflicts = 0

    for item in items:
        if not isinstance(item, dict):
            rejected.append(_rejected_item(key, None, "invalid_payload", "Registro invalido."))
            continue
        if not _valid_sync_item(item, config):
            rejected.append(_rejected_item(key, item.get("sync_id"), "invalid_payload", "Registro invalido."))
            continue
        sync_id = str(item.get("sync_id") or "").strip()
        existing = conn.execute(
            f"SELECT remote_updated_at, last_modified_device_id FROM {table} WHERE user_id = ? AND sync_id = ?",
            (user_id, sync_id),
        ).fetchone()

        # Old clients omit the baseline and keep full-pull compatibility. New clients
        # use the cloud revision to avoid overwriting changes from another device.
        baseline = str(item.get("last_remote_updated_at") or "").strip()
        current_revision = str(existing["remote_updated_at"] or "").strip() if existing else ""
        current_device = str(existing["last_modified_device_id"] or "").strip() if existing else ""
        if existing and baseline and baseline != current_revision and current_device != str(device_id or ""):
            conflicts += 1
            rejected.append(_rejected_item(key, sync_id, "conflict_remote_newer", "El registro fue actualizado por otro dispositivo."))
            continue
        last_modified_at = now
        base_columns = [
            "user_id", "sync_id", *fields, "created_at", "updated_at", "deleted_at", "sync_status", "remote_updated_at",
            "last_modified_device_id", "last_modified_device_name", "last_modified_at",
        ]
        placeholders = ", ".join(["?"] * len(base_columns))
        update_assignments = ", ".join(
            [
                *(f"{field} = excluded.{field}" for field in fields),
                f"created_at = COALESCE({table}.created_at, excluded.created_at)",
                "updated_at = excluded.updated_at",
                "deleted_at = excluded.deleted_at",
                "sync_status = excluded.sync_status",
                "remote_updated_at = excluded.remote_updated_at",
                "last_modified_device_id = excluded.last_modified_device_id",
                "last_modified_device_name = excluded.last_modified_device_name",
                "last_modified_at = excluded.last_modified_at",
            ]
        )
        values = [
            user_id,
            sync_id,
            *(item.get(field) for field in fields),
            item.get("created_at") or now,
            item.get("updated_at") or now,
            item.get("deleted_at"),
            item.get("sync_status") or "synced",
            now,
            device_id,
            device_name,
            last_modified_at,
        ]
        conn.execute(
            f"""
            INSERT INTO {table} ({", ".join(base_columns)})
            VALUES ({placeholders})
            ON CONFLICT(user_id, sync_id) DO UPDATE SET {update_assignments}
            """,
            tuple(values),
        )
        saved = conn.execute(
            f"SELECT 1 FROM {table} WHERE user_id = ? AND sync_id = ?",
            (user_id, sync_id),
        ).fetchone()
        if saved:
            accepted.append(sync_id)
        else:
            rejected.append(_rejected_item(key, sync_id, "save_failed", "No se pudo guardar el registro en cloud."))

    return accepted, rejected, conflicts


def _pull_table(conn, user_id: str, key: str, since: str | None = None, until: str | None = None) -> list[dict[str, Any]]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = ", ".join([
        *config["fields"],
        "created_at",
        "updated_at",
        "deleted_at",
        "sync_status",
        "remote_updated_at",
        "last_modified_device_id",
        "last_modified_device_name",
        "last_modified_at",
    ])
    where = ["user_id = ?"]
    params: list[Any] = [user_id]
    if since:
        where.append("remote_updated_at > ?")
        params.append(since)
    if until:
        where.append("remote_updated_at <= ?")
        params.append(until)
    return [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT sync_id, {fields}
            FROM {table}
            WHERE {" AND ".join(where)}
            ORDER BY {config["order"]}
            """,
            tuple(params),
        ).fetchall()
    ]


def _upsert_device(conn, user_id: str, device_id: Any, device_name: Any, now: str) -> None:
    clean_device_id = str(device_id or "").strip()
    if not clean_device_id:
        return
    clean_device_name = str(device_name or "Este dispositivo").strip()[:120] or "Este dispositivo"
    conn.execute(
        """
        INSERT INTO cloud_devices (user_id, device_id, device_name, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
            device_name = excluded.device_name,
            updated_at = excluded.updated_at,
            last_seen_at = excluded.last_seen_at
        """,
        (user_id, clean_device_id, clean_device_name, now, now, now),
    )


def _payload_counts(payload: dict[str, Any]) -> dict[str, int]:
    return {table: len(payload.get(table, []) or []) for table in SYNC_TABLES}


def get_current_user(authorization: str | None = Header(default=None)) -> UserOut:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sesion no valida.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Sesion no valida.")
    with connect() as conn:
        row = conn.execute(
            "SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Usuario no encontrado.")
    return row_to_user(row)


@app.get("/health")
def health():
    init_db()
    database = get_database_engine()
    return {
        "ok": True,
        "service": "scisonomics-cloud-auth",
        "database": database,
        "version": app.version,
        "schema_version": CLOUD_SCHEMA_VERSION,
        "sync_contract_version": SYNC_CONTRACT_VERSION,
        "cloud_schema_revision": CLOUD_SCHEMA_REVISION,
        "capabilities": {
            "sync_tables": list(SYNC_TABLES),
            "incremental_pull": True,
            "server_revisions": True,
            "tags_sync": True,
            "movimiento_tags_sync": True,
            "tombstones": True,
            "sync_cursor": True,
        },
    }


@app.post("/auth/register", response_model=AuthResponse)
def register(payload: RegisterRequest):
    email = validate_credentials(payload.email, payload.password)
    user_id = str(uuid4())
    timestamp = now_iso()
    display_name = payload.display_name.strip() if payload.display_name else None

    try:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, email, hash_password(payload.password), display_name, timestamp, timestamp),
            )
            row = conn.execute(
                "SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
    except Exception as exc:
        message = str(exc).lower()
        if "unique" in message or "duplicate key" in message:
            raise HTTPException(status_code=409, detail="Ya existe una cuenta con ese email.") from exc
        raise

    user = row_to_user(row)
    return AuthResponse(access_token=create_access_token(user.id), user=user)


@app.post("/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest):
    email = normalize_email(payload.email)
    with connect() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE LOWER(TRIM(email)) = ?",
            (email,),
        ).fetchone()

    if row is None or not row["password_hash"] or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Email o contrasena incorrectos.")

    user = row_to_user(row)
    return AuthResponse(access_token=create_access_token(user.id), user=user)


@app.get("/auth/me")
def me(user: UserOut = Depends(get_current_user)):
    return {"ok": True, "user_id": user.id, **user.dict()}


@app.post("/auth/logout")
def logout():
    return {"ok": True}


@app.get("/sync/health")
def sync_health(user: UserOut = Depends(get_current_user)):
    return {"ok": True, "service": "sync", "sync_ready": True, "user_id": user.id}


@app.post("/sync/push")
async def sync_push(payload: dict[str, Any], user: UserOut = Depends(get_current_user)):
    received = _payload_counts(payload)
    try:
        init_db()
        accepted = {table: [] for table in SYNC_TABLES}
        ignored = {table: 0 for table in SYNC_TABLES}
        conflicts = {table: 0 for table in SYNC_TABLES}
        rejected: list[RejectedSyncItem] = []
        now = now_iso()
        device_id = str(payload.get("device_id") or "").strip() or None
        device_name = str(payload.get("device_name") or "").strip() or None

        with connect() as conn:
            _upsert_device(conn, user.id, device_id, device_name, now)
            for table in SYNC_TABLES:
                items = payload.get(table, []) or []
                table_accepted, table_rejected, table_conflicts = _push_table(conn, user.id, table, items, now, device_id, device_name)
                accepted[table] = table_accepted
                ignored[table] = len(table_rejected)
                conflicts[table] = table_conflicts
                rejected.extend(table_rejected)

        counts = {}
        for table in SYNC_TABLES:
            counts[f"{table}_received"] = received[table]
            counts[f"{table}_saved"] = len(accepted[table])
        if any(received[table] != len(accepted[table]) + ignored[table] for table in SYNC_TABLES):
            raise HTTPException(status_code=500, detail="No se pudo confirmar el guardado de los datos en cloud.")
        if rejected:
            rejected_summary: dict[str, int] = {}
            for item in rejected:
                key = f"{item['entity']}:{item['code']}"
                rejected_summary[key] = rejected_summary.get(key, 0) + 1
            _logger.warning(
                "[sync-push] rejected user_id=%s rejected_count=%s summary=%s",
                short_identifier(user.id),
                len(rejected),
                rejected_summary,
            )
        return {
            "ok": True,
            "accepted": accepted,
            "rejected": rejected,
            "ignored": ignored,
            "conflicts": conflicts,
            "counts": counts,
            "device": {"device_id": device_id, "last_seen_at": now},
        }
    except HTTPException:
        raise
    except Exception as exc:
        _logger.exception(
            "[sync-push] failed user_id=%s counts=%s error_type=%s",
            short_identifier(user.id),
            received,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="No se pudo guardar la sincronizacion en cloud.") from exc


@app.get("/sync/pull")
def sync_pull(since: str | None = Query(default=None), user: UserOut = Depends(get_current_user)):
    try:
        init_db()
        cursor = now_iso()
        with connect() as conn:
            payload = {table: _pull_table(conn, user.id, table, since, cursor) for table in SYNC_TABLES}
        return {"ok": True, "cursor": cursor, "incremental": bool(since), **payload}
    except Exception as exc:
        _logger.exception(
            "[sync-pull] failed user_id=%s incremental=%s error_type=%s",
            short_identifier(user.id),
            bool(since),
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="No se pudo leer la sincronizacion desde cloud.") from exc


@app.get("/sync/debug-counts", dependencies=[Depends(_require_debug_endpoints_enabled)])
def sync_debug_counts(user: UserOut = Depends(get_current_user)):
    _require_debug_endpoints_enabled()
    init_db()
    with connect() as conn:
        counts: dict[str, int] = {}
        deleted: dict[str, int] = {}
        for table in SYNC_TABLES:
            cloud_table = SYNC_CONFIG[table]["table"]
            row = conn.execute(f"SELECT COUNT(*) AS total FROM {cloud_table} WHERE user_id = ?", (user.id,)).fetchone()
            deleted_row = conn.execute(
                f"SELECT COUNT(*) AS total FROM {cloud_table} WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at <> ''",
                (user.id,),
            ).fetchone()
            counts[table] = int(row["total"] if isinstance(row, dict) else row[0])
            deleted[table] = int(deleted_row["total"] if isinstance(deleted_row, dict) else deleted_row[0])
    return {"ok": True, "user_id": user.id, **counts, "deleted": deleted}


@app.get("/sync/devices")
def sync_devices(user: UserOut = Depends(get_current_user)):
    init_db()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT device_id, device_name, created_at, updated_at, last_seen_at
            FROM cloud_devices
            WHERE user_id = ?
            ORDER BY last_seen_at DESC
            """,
            (user.id,),
        ).fetchall()
    return {"ok": True, "devices": [dict(row) for row in rows]}


@app.post("/auth/google/start")
def google_start():
    client_id, _, redirect_uri = _google_config()
    init_db()
    login_request_id = secrets.token_urlsafe(32)
    now = now_iso()
    expires_at = (datetime.now(timezone.utc).replace(microsecond=0) + timedelta(minutes=10)).isoformat()
    with connect() as conn:
        _cleanup_google_login_requests(conn, now)
        conn.execute(
            """
            INSERT INTO google_login_requests (login_request_id, status, created_at, updated_at, expires_at)
            VALUES (?, 'pending', ?, ?, ?)
            """,
            (login_request_id, now, now, expires_at),
        )
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "prompt": "select_account",
            "state": login_request_id,
        }
    )
    return {
        "configured": True,
        "login_request_id": login_request_id,
        "auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}",
    }


@app.get("/auth/google/status/{login_request_id}")
def google_status(login_request_id: str):
    init_db()
    now = now_iso()
    with connect() as conn:
        _cleanup_google_login_requests(conn, now)
        row = conn.execute(
            """
            SELECT login_request_id, status, access_token, user_id, error_message, expires_at
            FROM google_login_requests
            WHERE login_request_id = ?
            """,
            (login_request_id,),
        ).fetchone()
        if not row:
            return {"status": "expired", "message": "La solicitud de Google expiro. Intenta nuevamente."}
        if row["status"] == "pending":
            return {"status": "pending"}
        if row["status"] == "error":
            return {"status": "error", "message": row["error_message"] or "No se pudo completar Google Login."}
        if row["status"] == "consumed":
            return {"status": "consumed", "message": "Esta solicitud de Google Login ya fue utilizada. Intenta nuevamente."}
        user_row = conn.execute(
            "SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?",
            (row["user_id"],),
        ).fetchone()
        if not user_row or not row["access_token"]:
            return {"status": "error", "message": "No se pudo recuperar la sesion de Google."}
        access_token = row["access_token"]
        user = row_to_user(user_row)
        conn.execute(
            """
            UPDATE google_login_requests
            SET status = 'consumed', access_token = NULL, updated_at = ?
            WHERE login_request_id = ?
            """,
            (now, login_request_id),
        )
        return {"status": "completed", "access_token": access_token, "user": user}


@app.get("/auth/google/callback", response_class=HTMLResponse)
def google_callback(code: str = Query(default=""), state: str = Query(default=""), error: str = Query(default="")):
    init_db()
    now = now_iso()
    if not state:
        raise HTTPException(status_code=400, detail="Solicitud de Google invalida.")
    try:
        client_id, client_secret, redirect_uri = _google_config()
        with connect() as conn:
            row = conn.execute(
                "SELECT login_request_id, status, expires_at FROM google_login_requests WHERE login_request_id = ?",
                (state,),
            ).fetchone()
            if not row or row["expires_at"] < now:
                raise HTTPException(status_code=400, detail="La solicitud de Google expiro.")
            if error:
                conn.execute(
                    "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                    ("Google Login fue cancelado o rechazado.", now, state),
                )
                return _google_result_page(False, "Google Login fue cancelado. Ya podes cerrar esta ventana.")
            if not code:
                raise HTTPException(status_code=400, detail="Google no devolvio codigo de autorizacion.")

        profile = _exchange_google_code(code, client_id, client_secret, redirect_uri)
        with connect() as conn:
            user = _find_or_create_google_user(conn, profile, now)
            access_token = create_access_token(user.id)
            conn.execute(
                """
                UPDATE google_login_requests
                SET status = 'completed', access_token = ?, user_id = ?, updated_at = ?
                WHERE login_request_id = ?
                """,
                (access_token, user.id, now, state),
            )
        return _google_result_page(True, "Login completado. Ya podes volver a ScisoNomics.")
    except HTTPException as exc:
        with connect() as conn:
            conn.execute(
                "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                (str(exc.detail), now, state),
            )
        raise
    except Exception:
        with connect() as conn:
            conn.execute(
                "UPDATE google_login_requests SET status = 'error', error_message = ?, updated_at = ? WHERE login_request_id = ?",
                ("No se pudo completar Google Login.", now, state),
            )
        return _google_result_page(False, "No se pudo completar Google Login. Volve a ScisoNomics e intenta nuevamente.")


def _google_result_page(ok: bool, message: str) -> HTMLResponse:
    color = "#0f766e" if ok else "#b45309"
    return HTMLResponse(
        f"""
        <!doctype html>
        <html lang="es">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>ScisoNomics Google Login</title>
            <style>
              body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }}
              main {{ max-width: 520px; margin: 24px; padding: 28px; border: 1px solid rgba(148,163,184,.24); border-radius: 24px; background: rgba(15,23,42,.86); box-shadow: 0 24px 80px rgba(0,0,0,.32); }}
              .badge {{ display: inline-block; color: white; background: {color}; border-radius: 999px; padding: 6px 12px; font-size: 13px; font-weight: 700; }}
              h1 {{ margin: 18px 0 8px; font-size: 28px; }}
              p {{ color: #cbd5e1; line-height: 1.6; }}
            </style>
          </head>
          <body>
            <main>
              <span class="badge">ScisoNomics</span>
              <h1>{'Cuenta conectada' if ok else 'No se pudo conectar'}</h1>
              <p>{message}</p>
            </main>
          </body>
        </html>
        """
    )

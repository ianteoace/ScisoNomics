from __future__ import annotations

from datetime import datetime, timezone
import os
import re
from urllib.parse import urlencode
from uuid import uuid4
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import create_access_token, decode_access_token, get_jwt_secret, hash_password, verify_password
from .db import connect, get_database_engine, get_database_path, init_db
from .schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut


app = FastAPI(title="ScisoNomics Cloud Auth API", version="2.4.0")


def allowed_origins() -> list[str]:
    raw = os.getenv("SCISONOMICS_ALLOWED_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]

_allowed_origins = allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=_allowed_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.on_event("startup")
def startup() -> None:
    get_jwt_secret()
    init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def validate_credentials(email: str, password: str) -> str:
    normalized_email = normalize_email(email)
    if not EMAIL_RE.match(normalized_email):
        raise HTTPException(status_code=422, detail="Ingresa un email valido.")
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="La contrasena debe tener al menos 8 caracteres.")
    return normalized_email


def row_to_user(row) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


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


def incoming_is_newer(incoming_updated_at: Any, stored_updated_at: Any) -> bool:
    incoming_dt = parse_sync_datetime(incoming_updated_at)
    stored_dt = parse_sync_datetime(stored_updated_at)
    if incoming_dt is None:
        return False
    if stored_dt is None:
        return True
    return incoming_dt >= stored_dt


SYNC_TABLES = ("categorias", "movimientos", "metas_ahorro", "gastos_programados", "gastos_fijos", "presupuestos")

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
}


def _valid_sync_item(item: dict[str, Any], config: dict[str, Any]) -> bool:
    sync_id = str(item.get("sync_id") or "").strip()
    if not sync_id:
        return False
    return all(item.get(field) not in (None, "") for field in config["required"])


def _push_table(conn, user_id: str, key: str, items: list[dict[str, Any]], now: str) -> tuple[list[str], int]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = list(config["fields"])
    accepted: list[str] = []
    ignored = 0

    for item in items:
        if not isinstance(item, dict) or not _valid_sync_item(item, config):
            ignored += 1
            continue
        sync_id = str(item.get("sync_id") or "").strip()
        existing = conn.execute(
            f"SELECT updated_at FROM {table} WHERE user_id = ? AND sync_id = ?",
            (user_id, sync_id),
        ).fetchone()

        if existing and not incoming_is_newer(item.get("updated_at"), existing["updated_at"]):
            accepted.append(sync_id)
            continue

        base_columns = ["user_id", "sync_id", *fields, "created_at", "updated_at", "deleted_at", "sync_status", "remote_updated_at"]
        placeholders = ", ".join(["?"] * len(base_columns))
        update_assignments = ", ".join(
            [
                *(f"{field} = excluded.{field}" for field in fields),
                f"created_at = COALESCE({table}.created_at, excluded.created_at)",
                "updated_at = excluded.updated_at",
                "deleted_at = excluded.deleted_at",
                "sync_status = excluded.sync_status",
                "remote_updated_at = excluded.remote_updated_at",
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
            ignored += 1

    return accepted, ignored


def _pull_table(conn, user_id: str, key: str) -> list[dict[str, Any]]:
    config = SYNC_CONFIG[key]
    table = config["table"]
    fields = ", ".join([*config["fields"], "created_at", "updated_at", "deleted_at", "sync_status", "remote_updated_at"])
    return [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT sync_id, {fields}
            FROM {table}
            WHERE user_id = ?
            ORDER BY {config["order"]}
            """,
            (user_id,),
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
    response = {"ok": True, "service": "scisonomics-cloud-auth", "database": database, "version": app.version}
    if database == "sqlite":
        response["database_path"] = str(get_database_path())
    return response


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
            "SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE email = ?",
            (email,),
        ).fetchone()

    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Email o contrasena incorrectos.")

    user = row_to_user(row)
    return AuthResponse(access_token=create_access_token(user.id), user=user)


@app.get("/auth/me", response_model=UserOut)
def me(user: UserOut = Depends(get_current_user)):
    return user


@app.post("/auth/logout")
def logout():
    return {"ok": True}


@app.get("/sync/health")
def sync_health(user: UserOut = Depends(get_current_user)):
    return {"ok": True, "sync_ready": True, "user_id": user.id}


@app.post("/sync/push")
async def sync_push(payload: dict[str, Any], user: UserOut = Depends(get_current_user)):
    init_db()
    accepted = {table: [] for table in SYNC_TABLES}
    ignored = {table: 0 for table in SYNC_TABLES}
    received = {table: len(payload.get(table, []) or []) for table in SYNC_TABLES}
    now = now_iso()

    with connect() as conn:
        _upsert_device(conn, user.id, payload.get("device_id"), payload.get("device_name"), now)
        for table in SYNC_TABLES:
            items = payload.get(table, []) or []
            table_accepted, table_ignored = _push_table(conn, user.id, table, items, now)
            accepted[table] = table_accepted
            ignored[table] = table_ignored

    counts = {}
    for table in SYNC_TABLES:
        counts[f"{table}_received"] = received[table]
        counts[f"{table}_saved"] = len(accepted[table])
    if any(received[table] != len(accepted[table]) for table in SYNC_TABLES):
        raise HTTPException(status_code=500, detail="No se pudo confirmar el guardado de los datos en cloud.")
    return {"ok": True, "accepted": accepted, "ignored": ignored, "counts": counts}


@app.get("/sync/pull")
def sync_pull(user: UserOut = Depends(get_current_user)):
    init_db()
    with connect() as conn:
        payload = {table: _pull_table(conn, user.id, table) for table in SYNC_TABLES}
    return {"ok": True, **payload}


@app.get("/sync/debug-counts")
def sync_debug_counts(user: UserOut = Depends(get_current_user)):
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


@app.get("/auth/google/start")
def google_start():
    client_id = os.getenv("SCISONOMICS_GOOGLE_CLIENT_ID", "").strip()
    redirect_uri = os.getenv("SCISONOMICS_GOOGLE_REDIRECT_URI", "").strip()
    if not client_id or not redirect_uri:
        return {
            "configured": False,
            "message": "El inicio con Google todavia no esta configurado en este entorno.",
        }

    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "access_type": "offline",
            "prompt": "select_account",
        }
    )
    return {
        "configured": True,
        "authorization_url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}",
    }


@app.get("/auth/google/callback")
def google_callback():
    raise HTTPException(
        status_code=501,
        detail="El inicio con Google todavia no esta habilitado. Faltan credenciales OAuth y manejo de callback.",
    )

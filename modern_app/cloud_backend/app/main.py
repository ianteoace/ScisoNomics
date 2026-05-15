from __future__ import annotations

from datetime import datetime, timezone
import os
import re
from urllib.parse import urlencode
from uuid import uuid4
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import create_access_token, decode_access_token, hash_password, verify_password
from .db import connect, get_database_path, init_db
from .schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut


app = FastAPI(title="ScisoNomics Cloud Auth API", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.on_event("startup")
def startup() -> None:
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
    return {"ok": True, "service": "scisonomics-cloud-auth", "database": str(get_database_path())}


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
        if "UNIQUE" in str(exc).upper():
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
    categorias = payload.get("categorias", []) or []
    movimientos = payload.get("movimientos", []) or []
    accepted = {"categorias": [], "movimientos": []}
    ignored = {"categorias": 0, "movimientos": 0}
    received = {"categorias": len(categorias), "movimientos": len(movimientos)}
    now = now_iso()

    with connect() as conn:
        for item in categorias:
            sync_id = str(item.get("sync_id") or "").strip()
            nombre = str(item.get("nombre") or "").strip()
            tipo = str(item.get("tipo") or "").strip()
            if not sync_id or not nombre or not tipo:
                ignored["categorias"] += 1
                continue

            existing = conn.execute(
                "SELECT updated_at FROM cloud_categorias WHERE user_id = ? AND sync_id = ?",
                (user.id, sync_id),
            ).fetchone()
            if existing and not incoming_is_newer(item.get("updated_at"), existing["updated_at"]):
                ignored["categorias"] += 1
                continue

            conn.execute(
                """
                INSERT INTO cloud_categorias (
                    user_id, sync_id, nombre, tipo, color, icono, created_at, updated_at,
                    deleted_at, sync_status, remote_updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, sync_id) DO UPDATE SET
                    nombre = excluded.nombre,
                    tipo = excluded.tipo,
                    color = excluded.color,
                    icono = excluded.icono,
                    created_at = COALESCE(cloud_categorias.created_at, excluded.created_at),
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at,
                    sync_status = excluded.sync_status,
                    remote_updated_at = excluded.remote_updated_at
                """,
                (
                    user.id,
                    sync_id,
                    nombre,
                    tipo,
                    item.get("color"),
                    item.get("icono"),
                    item.get("created_at") or now,
                    item.get("updated_at") or now,
                    item.get("deleted_at"),
                    item.get("sync_status") or "synced",
                    now,
                ),
            )
            saved = conn.execute(
                "SELECT 1 FROM cloud_categorias WHERE user_id = ? AND sync_id = ?",
                (user.id, sync_id),
            ).fetchone()
            if saved:
                accepted["categorias"].append(sync_id)
            else:
                ignored["categorias"] += 1

        for item in movimientos:
            sync_id = str(item.get("sync_id") or "").strip()
            tipo = str(item.get("tipo") or "").strip()
            fecha = str(item.get("fecha") or "").strip()
            if not sync_id or not tipo or not fecha:
                ignored["movimientos"] += 1
                continue

            existing = conn.execute(
                "SELECT updated_at FROM cloud_movimientos WHERE user_id = ? AND sync_id = ?",
                (user.id, sync_id),
            ).fetchone()
            if existing and not incoming_is_newer(item.get("updated_at"), existing["updated_at"]):
                ignored["movimientos"] += 1
                continue

            conn.execute(
                """
                INSERT INTO cloud_movimientos (
                    user_id, sync_id, tipo, monto, descripcion, categoria_id, categoria_sync_id,
                    fecha, created_at, updated_at, deleted_at, sync_status, remote_updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, sync_id) DO UPDATE SET
                    tipo = excluded.tipo,
                    monto = excluded.monto,
                    descripcion = excluded.descripcion,
                    categoria_id = excluded.categoria_id,
                    categoria_sync_id = excluded.categoria_sync_id,
                    fecha = excluded.fecha,
                    created_at = COALESCE(cloud_movimientos.created_at, excluded.created_at),
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at,
                    sync_status = excluded.sync_status,
                    remote_updated_at = excluded.remote_updated_at
                """,
                (
                    user.id,
                    sync_id,
                    tipo,
                    float(item.get("monto") or 0),
                    item.get("descripcion") or "",
                    item.get("categoria_id"),
                    item.get("categoria_sync_id"),
                    fecha,
                    item.get("created_at") or now,
                    item.get("updated_at") or now,
                    item.get("deleted_at"),
                    item.get("sync_status") or "synced",
                    now,
                ),
            )
            saved = conn.execute(
                "SELECT 1 FROM cloud_movimientos WHERE user_id = ? AND sync_id = ?",
                (user.id, sync_id),
            ).fetchone()
            if saved:
                accepted["movimientos"].append(sync_id)
            else:
                ignored["movimientos"] += 1

    counts = {
        "categorias_received": received["categorias"],
        "categorias_saved": len(accepted["categorias"]),
        "movimientos_received": received["movimientos"],
        "movimientos_saved": len(accepted["movimientos"]),
    }
    if (received["categorias"] and not accepted["categorias"]) or (received["movimientos"] and not accepted["movimientos"]):
        raise HTTPException(status_code=500, detail="No se pudo confirmar el guardado de los datos en cloud.")
    return {"ok": True, "accepted": accepted, "ignored": ignored, "counts": counts}


@app.get("/sync/pull")
def sync_pull(user: UserOut = Depends(get_current_user)):
    init_db()
    with connect() as conn:
        categorias = [
            dict(row)
            for row in conn.execute(
                """
                SELECT sync_id, nombre, tipo, color, icono, created_at, updated_at,
                       deleted_at, sync_status, remote_updated_at
                FROM cloud_categorias
                WHERE user_id = ?
                ORDER BY nombre
                """,
                (user.id,),
            ).fetchall()
        ]
        movimientos = [
            dict(row)
            for row in conn.execute(
                """
                SELECT sync_id, tipo, monto, descripcion, categoria_id, categoria_sync_id,
                       fecha, created_at, updated_at, deleted_at, sync_status, remote_updated_at
                FROM cloud_movimientos
                WHERE user_id = ?
                ORDER BY fecha DESC, id DESC
                """,
                (user.id,),
            ).fetchall()
        ]
    return {"ok": True, "categorias": categorias, "movimientos": movimientos}


@app.get("/sync/debug-counts")
def sync_debug_counts(user: UserOut = Depends(get_current_user)):
    init_db()
    with connect() as conn:
        categorias = int(
            conn.execute("SELECT COUNT(*) FROM cloud_categorias WHERE user_id = ?", (user.id,)).fetchone()[0]
        )
        movimientos = int(
            conn.execute("SELECT COUNT(*) FROM cloud_movimientos WHERE user_id = ?", (user.id,)).fetchone()[0]
        )
    return {"ok": True, "user_id": user.id, "categorias": categorias, "movimientos": movimientos}


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

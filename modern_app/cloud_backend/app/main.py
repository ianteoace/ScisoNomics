from __future__ import annotations

from datetime import datetime, timezone
import os
import re
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import create_access_token, decode_access_token, hash_password, verify_password
from .db import connect, get_database_path, init_db
from .schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut


app = FastAPI(title="ScisoNomics Cloud Auth API", version="2.0.0")

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

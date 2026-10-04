-- SQLx enables foreign keys for every SQLite connection, including its pool.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL CHECK(length(trim(nombre)) BETWEEN 1 AND 120),
    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    UNIQUE(owner_user_id, nombre, tipo),
    UNIQUE(id, owner_user_id)
);

CREATE TABLE IF NOT EXISTS movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL CHECK(
        length(fecha) = 10 AND fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(fecha, '+0 days') IS NOT NULL AND date(fecha, '+0 days') = fecha
    ),
    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
    categoria_id INTEGER NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '' CHECK(length(descripcion) <= 500),
    monto REAL NOT NULL CHECK(monto > 0),
    nota TEXT NOT NULL DEFAULT '' CHECK(length(nota) <= 4000),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    FOREIGN KEY(categoria_id, owner_user_id) REFERENCES categorias(id, owner_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_sync_id ON categorias(sync_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_sync_id ON movimientos(sync_id);
CREATE INDEX IF NOT EXISTS idx_categorias_owner_tipo ON categorias(owner_user_id, tipo);
CREATE INDEX IF NOT EXISTS idx_movimientos_owner_fecha ON movimientos(owner_user_id, fecha, id);
CREATE INDEX IF NOT EXISTS idx_movimientos_categoria_owner ON movimientos(categoria_id, owner_user_id);

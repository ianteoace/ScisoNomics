-- Additive upgrade: v1 records and their sync identities remain unchanged.
CREATE TABLE gastos_fijos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria_id INTEGER NOT NULL,
    descripcion TEXT NOT NULL CHECK(length(trim(descripcion)) BETWEEN 1 AND 500),
    monto REAL NOT NULL CHECK(monto > 0),
    dia_vencimiento INTEGER NOT NULL CHECK(dia_vencimiento BETWEEN 1 AND 31),
    activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL UNIQUE CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    FOREIGN KEY(categoria_id, owner_user_id) REFERENCES categorias(id, owner_user_id)
);
CREATE TABLE presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria_id INTEGER NOT NULL,
    mes INTEGER NOT NULL CHECK(mes BETWEEN 1 AND 12),
    anio INTEGER NOT NULL CHECK(anio BETWEEN 1 AND 9999),
    monto REAL NOT NULL CHECK(monto > 0),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL UNIQUE CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    UNIQUE(owner_user_id, categoria_id, mes, anio),
    FOREIGN KEY(categoria_id, owner_user_id) REFERENCES categorias(id, owner_user_id)
);
CREATE TABLE metas_ahorro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL CHECK(length(trim(nombre)) BETWEEN 1 AND 160),
    monto_objetivo REAL NOT NULL CHECK(monto_objetivo > 0),
    monto_inicial REAL NOT NULL DEFAULT 0 CHECK(monto_inicial >= 0),
    fecha_objetivo TEXT CHECK(fecha_objetivo IS NULL OR (
        length(fecha_objetivo) = 10 AND fecha_objetivo GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(fecha_objetivo, '+0 days') IS NOT NULL AND date(fecha_objetivo, '+0 days') = fecha_objetivo
    )),
    descripcion TEXT NOT NULL DEFAULT '' CHECK(length(descripcion) <= 2000),
    estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('activa','pausada','completada')),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL UNIQUE CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT
);
ALTER TABLE movimientos ADD COLUMN meta_id INTEGER REFERENCES metas_ahorro(id);
CREATE INDEX idx_gastos_fijos_owner_activo_dia ON gastos_fijos(owner_user_id, activo, dia_vencimiento);
CREATE INDEX idx_gastos_fijos_categoria_owner ON gastos_fijos(categoria_id, owner_user_id);
CREATE INDEX idx_presupuestos_owner_periodo ON presupuestos(owner_user_id, anio, mes);
CREATE INDEX idx_metas_owner_estado ON metas_ahorro(owner_user_id, estado);
CREATE INDEX idx_movimientos_meta_owner ON movimientos(meta_id, owner_user_id, tipo);

-- ALTER TABLE cannot add a composite FK without rebuilding v1 movimientos.
-- The FK checks identity and these triggers enforce the same-owner relationship.
CREATE TRIGGER movimientos_meta_owner_insert BEFORE INSERT ON movimientos
WHEN NEW.meta_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM metas_ahorro WHERE id = NEW.meta_id AND owner_user_id = NEW.owner_user_id
)
BEGIN SELECT RAISE(ABORT, 'invalid meta owner'); END;
CREATE TRIGGER movimientos_meta_owner_update BEFORE UPDATE OF meta_id, owner_user_id ON movimientos
WHEN NEW.meta_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM metas_ahorro WHERE id = NEW.meta_id AND owner_user_id = NEW.owner_user_id
)
BEGIN SELECT RAISE(ABORT, 'invalid meta owner'); END;

-- Match desktop cascades within the same atomic soft-delete statement.
CREATE TRIGGER metas_soft_delete_unlink AFTER UPDATE OF deleted_at ON metas_ahorro
WHEN NEW.deleted_at IS NOT NULL AND NEW.deleted_at <> '' AND (OLD.deleted_at IS NULL OR OLD.deleted_at = '')
BEGIN
    UPDATE movimientos SET meta_id = NULL, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
    WHERE meta_id = NEW.id AND owner_user_id = NEW.owner_user_id;
END;
CREATE TRIGGER categorias_soft_delete_planning AFTER UPDATE OF deleted_at ON categorias
WHEN NEW.deleted_at IS NOT NULL AND NEW.deleted_at <> '' AND (OLD.deleted_at IS NULL OR OLD.deleted_at = '')
BEGIN
    UPDATE gastos_fijos SET deleted_at = NEW.deleted_at, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
    WHERE categoria_id = NEW.id AND owner_user_id = NEW.owner_user_id AND (deleted_at IS NULL OR deleted_at = '');
    UPDATE presupuestos SET deleted_at = NEW.deleted_at, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
    WHERE categoria_id = NEW.id AND owner_user_id = NEW.owner_user_id AND (deleted_at IS NULL OR deleted_at = '');
END;

-- Additive scheduling data. Calendar remains a derived view of movements.
CREATE TABLE gastos_programados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    descripcion TEXT NOT NULL CHECK(length(trim(descripcion)) BETWEEN 1 AND 500),
    categoria_id INTEGER NOT NULL,
    monto_estimado REAL NOT NULL CHECK(monto_estimado > 0),
    fecha_vencimiento TEXT NOT NULL CHECK(
        length(fecha_vencimiento) = 10 AND fecha_vencimiento GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND substr(fecha_vencimiento,1,4) <> '0000'
        AND date(fecha_vencimiento, '+0 days') IS NOT NULL AND date(fecha_vencimiento, '+0 days') = fecha_vencimiento
    ),
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','pagado','cancelado')),
    es_recurrente INTEGER NOT NULL DEFAULT 0 CHECK(es_recurrente IN (0,1)),
    frecuencia TEXT CHECK(
        (es_recurrente = 0 AND frecuencia IS NULL)
        OR (es_recurrente = 1 AND frecuencia IS NOT NULL AND frecuencia IN ('mensual','semanal','anual'))
    ),
    owner_user_id TEXT NOT NULL DEFAULT 'local' CHECK(length(trim(owner_user_id)) > 0),
    sync_id TEXT NOT NULL UNIQUE CHECK(length(trim(sync_id)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    FOREIGN KEY(categoria_id, owner_user_id) REFERENCES categorias(id, owner_user_id)
);
CREATE INDEX idx_programados_owner_estado_fecha ON gastos_programados(owner_user_id, estado, fecha_vencimiento);
CREATE INDEX idx_programados_categoria_owner ON gastos_programados(categoria_id, owner_user_id);
CREATE TRIGGER categorias_soft_delete_scheduling AFTER UPDATE OF deleted_at ON categorias
WHEN NEW.deleted_at IS NOT NULL AND NEW.deleted_at <> '' AND (OLD.deleted_at IS NULL OR OLD.deleted_at = '')
BEGIN
    UPDATE gastos_programados SET deleted_at = NEW.deleted_at, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending'
    WHERE categoria_id = NEW.id AND owner_user_id = NEW.owner_user_id AND (deleted_at IS NULL OR deleted_at = '');
END;

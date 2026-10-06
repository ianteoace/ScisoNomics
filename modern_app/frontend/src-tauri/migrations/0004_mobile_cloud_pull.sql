-- No rows are reassigned. Sync identity is scoped to the internal account owner.
DROP INDEX idx_categorias_sync_id;
DROP INDEX idx_movimientos_sync_id;
CREATE UNIQUE INDEX idx_categorias_owner_sync_id ON categorias(owner_user_id, sync_id);
CREATE UNIQUE INDEX idx_movimientos_owner_sync_id ON movimientos(owner_user_id, sync_id);
ALTER TABLE categorias ADD COLUMN last_remote_updated_at TEXT;
ALTER TABLE categorias ADD COLUMN last_remote_device_id TEXT;
ALTER TABLE movimientos ADD COLUMN last_remote_updated_at TEXT;
ALTER TABLE movimientos ADD COLUMN last_remote_device_id TEXT;
CREATE TABLE mobile_pull_state (
    owner_user_id TEXT PRIMARY KEY CHECK(owner_user_id <> 'local' AND length(trim(owner_user_id)) > 0),
    cursor TEXT NOT NULL,
    supported_entities_version INTEGER NOT NULL DEFAULT 1 CHECK(supported_entities_version = 1),
    updated_at TEXT NOT NULL
);

-- Upload metadata only; no existing record/owner/sync identity is reassigned.
ALTER TABLE categorias ADD COLUMN last_remote_revision TEXT;
ALTER TABLE categorias ADD COLUMN local_change_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categorias ADD COLUMN sync_error_code TEXT;
ALTER TABLE movimientos ADD COLUMN last_remote_revision TEXT;
ALTER TABLE movimientos ADD COLUMN local_change_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movimientos ADD COLUMN sync_error_code TEXT;

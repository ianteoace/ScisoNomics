from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sqlite3
import shutil
import uuid

from .paths import ensure_app_data_layout, get_backup_dir, get_db_path, get_logs_dir

DB_PATH = get_db_path()


class Database:
    def __init__(self, db_path: Path | None = None) -> None:
        ensure_app_data_layout()
        self.db_path = db_path or DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def init_db(self) -> None:
        with self.connect() as conn:
            try:
                self._backup_before_risky_migrations(conn)
                self._migrate_movimientos_allow_ahorro(conn)
                conn.executescript(
                    """
                CREATE TABLE IF NOT EXISTS categorias (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                    UNIQUE(nombre, tipo)
                );

                CREATE TABLE IF NOT EXISTS movimientos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fecha TEXT NOT NULL,
                    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                    categoria_id INTEGER NOT NULL,
                    descripcion TEXT,
                    monto REAL NOT NULL CHECK(monto >= 0),
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id)
                );

                CREATE TABLE IF NOT EXISTS gastos_fijos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    categoria_id INTEGER NOT NULL,
                    descripcion TEXT,
                    monto REAL NOT NULL CHECK(monto >= 0),
                    dia_vencimiento INTEGER NOT NULL CHECK(dia_vencimiento BETWEEN 1 AND 31),
                    activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id)
                );

                CREATE TABLE IF NOT EXISTS gastos_programados (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    descripcion TEXT NOT NULL,
                    categoria_id INTEGER NOT NULL,
                    monto_estimado REAL NOT NULL CHECK(monto_estimado > 0),
                    fecha_vencimiento TEXT NOT NULL,
                    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'pagado', 'cancelado')),
                    es_recurrente INTEGER NOT NULL DEFAULT 0 CHECK(es_recurrente IN (0,1)),
                    frecuencia TEXT CHECK(frecuencia IN ('mensual', 'semanal', 'anual') OR frecuencia IS NULL),
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id)
                );

                CREATE TABLE IF NOT EXISTS presupuestos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    categoria_id INTEGER NOT NULL,
                    mes INTEGER NOT NULL CHECK(mes BETWEEN 1 AND 12),
                    anio INTEGER NOT NULL,
                    monto REAL NOT NULL CHECK(monto > 0),
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id),
                    UNIQUE(categoria_id, mes, anio)
                );

                CREATE TABLE IF NOT EXISTS metas_ahorro (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    monto_objetivo REAL NOT NULL CHECK(monto_objetivo > 0),
                    monto_inicial REAL NOT NULL DEFAULT 0 CHECK(monto_inicial >= 0),
                    fecha_objetivo TEXT,
                    descripcion TEXT,
                    estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('activa', 'completada', 'pausada')),
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL UNIQUE,
                    color TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS movimiento_tags (
                    movimiento_id INTEGER NOT NULL,
                    tag_id INTEGER NOT NULL,
                    PRIMARY KEY(movimiento_id, tag_id),
                    FOREIGN KEY (movimiento_id) REFERENCES movimientos(id) ON DELETE CASCADE,
                    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS app_config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS sync_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sync_id TEXT NOT NULL UNIQUE,
                    device_id TEXT,
                    mode TEXT NOT NULL CHECK(mode IN ('manual', 'auto')),
                    status TEXT NOT NULL CHECK(status IN ('success', 'error', 'skipped')),
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    duration_ms INTEGER DEFAULT 0,
                    pending_total INTEGER DEFAULT 0,
                    pushed_total INTEGER DEFAULT 0,
                    pulled_total INTEGER DEFAULT 0,
                    deleted_total INTEGER DEFAULT 0,
                    conflicts_total INTEGER DEFAULT 0,
                    remote_changes_total INTEGER DEFAULT 0,
                    applied_remote_total INTEGER DEFAULT 0,
                    kept_local_total INTEGER DEFAULT 0,
                    error_message TEXT,
                    details_json TEXT
                );

                CREATE TABLE IF NOT EXISTS sync_conflicts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conflict_id TEXT NOT NULL UNIQUE,
                    table_name TEXT NOT NULL,
                    record_sync_id TEXT NOT NULL,
                    local_updated_at TEXT,
                    remote_updated_at TEXT,
                    last_synced_at TEXT,
                    resolution TEXT NOT NULL CHECK(resolution IN ('kept_local', 'applied_remote', 'ignored')),
                    remote_device_id TEXT,
                    remote_device_name TEXT,
                    detected_at TEXT NOT NULL,
                    resolved_at TEXT,
                    details_json TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos(fecha);
                CREATE INDEX IF NOT EXISTS idx_movimientos_tipo ON movimientos(tipo);
                CREATE INDEX IF NOT EXISTS idx_movimientos_categoria_id ON movimientos(categoria_id);
                CREATE INDEX IF NOT EXISTS idx_gastos_fijos_activo ON gastos_fijos(activo);
                CREATE INDEX IF NOT EXISTS idx_gastos_fijos_categoria_id ON gastos_fijos(categoria_id);
                CREATE INDEX IF NOT EXISTS idx_gastos_programados_fecha_vencimiento ON gastos_programados(fecha_vencimiento);
                CREATE INDEX IF NOT EXISTS idx_gastos_programados_estado ON gastos_programados(estado);
                CREATE INDEX IF NOT EXISTS idx_gastos_programados_categoria_id ON gastos_programados(categoria_id);
                CREATE INDEX IF NOT EXISTS idx_presupuestos_periodo ON presupuestos(anio, mes);
                CREATE INDEX IF NOT EXISTS idx_presupuestos_categoria ON presupuestos(categoria_id);
                CREATE INDEX IF NOT EXISTS idx_metas_ahorro_estado ON metas_ahorro(estado);
                CREATE INDEX IF NOT EXISTS idx_movimiento_tags_tag_id ON movimiento_tags(tag_id);
                CREATE INDEX IF NOT EXISTS idx_movimiento_tags_movimiento_id ON movimiento_tags(movimiento_id);
                CREATE INDEX IF NOT EXISTS idx_sync_history_finished_at ON sync_history(finished_at);
                CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);
                CREATE INDEX IF NOT EXISTS idx_sync_conflicts_detected_at ON sync_conflicts(detected_at);
                CREATE INDEX IF NOT EXISTS idx_sync_conflicts_record ON sync_conflicts(table_name, record_sync_id);

                """
                )
                self._migrate_categorias_allow_extended_types(conn)
                self._recreate_categorias_validation_triggers(conn)
                self._migrate_movimientos_meta_y_nota(conn)
                self._migrate_sync_columns(conn)
                self._migrate_owner_columns(conn)
                self._seed_default_categories(conn)
                self._ensure_required_movement_categories(conn)
                self._seed_default_tags(conn)
                self._migrate_sync_columns(conn)
                self._migrate_owner_columns(conn)
            except sqlite3.OperationalError as exc:
                if "readonly" in str(exc).lower():
                    return
                raise

    def _seed_default_categories(self, conn: sqlite3.Connection) -> None:
        count_row = conn.execute("SELECT COUNT(*) AS total FROM categorias WHERE owner_user_id = 'local'").fetchone()
        if count_row and int(count_row["total"] or 0) > 0:
            return

        defaults = [
            ("Sueldo", "ingreso"),
            ("Freelance", "ingreso"),
            ("Inversiones", "inversion"),
            ("Comida", "gasto"),
            ("Transporte", "gasto"),
            ("Servicios", "gasto"),
            ("Alquiler", "gasto"),
            ("Salud", "gasto"),
            ("Ahorro", "ahorro"),
        ]
        conn.executemany("INSERT INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')", defaults)

    def _ensure_required_movement_categories(self, conn: sqlite3.Connection) -> None:
        migration_key = "migration_required_categories_v0241"
        existing = conn.execute(
            "SELECT value FROM app_config WHERE key = ?",
            (migration_key,),
        ).fetchone()
        if existing:
            return

        tipo_ahorro = conn.execute(
            "SELECT COUNT(*) FROM categorias WHERE tipo = 'ahorro' AND owner_user_id = 'local'"
        ).fetchone()
        tipo_inversion = conn.execute(
            "SELECT COUNT(*) FROM categorias WHERE tipo = 'inversion' AND owner_user_id = 'local'"
        ).fetchone()

        if int(tipo_ahorro[0] or 0) == 0:
            conn.execute(
                "INSERT INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')",
                ("Ahorro", "ahorro"),
            )
        if int(tipo_inversion[0] or 0) == 0:
            conn.execute(
                "INSERT INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')",
                ("Inversion", "inversion"),
            )

        conn.execute(
            """
            INSERT INTO app_config (key, value, updated_at)
            VALUES (?, '1', CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (migration_key,),
        )

    def _migrate_categorias_allow_extended_types(self, conn: sqlite3.Connection) -> None:
        create_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='categorias'"
        ).fetchone()
        if not create_sql or not create_sql[0]:
            return

        sql_text = str(create_sql[0]).lower()
        needs_table_migration = "'ahorro'" not in sql_text or "'inversion'" not in sql_text
        if not needs_table_migration:
            return

        self._backup_before_categories_type_migration()
        self._append_startup_log("Iniciando migracion segura de categorias para tipos ahorro/inversion.")

        # Capturar estructura e indices actuales para preservar columnas/ids y relaciones.
        table_info = conn.execute("PRAGMA table_info(categorias)").fetchall()
        if not table_info:
            return

        index_rows = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='categorias' AND sql IS NOT NULL"
        ).fetchall()

        col_defs: list[str] = []
        col_names: list[str] = []
        pk_cols = 0
        for row in table_info:
            name = str(row["name"])
            col_type = str(row["type"] or "")
            notnull = int(row["notnull"] or 0) == 1
            default = row["dflt_value"]
            pk = int(row["pk"] or 0)
            pk_cols += 1 if pk else 0

            if name == "tipo":
                col_def = "tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion'))"
            else:
                col_def = f"{name} {col_type}".strip()
                if pk and pk_cols == 1 and col_type.upper() == "INTEGER":
                    col_def = "id INTEGER PRIMARY KEY AUTOINCREMENT" if name == "id" else f"{name} INTEGER PRIMARY KEY"
                elif pk and pk_cols == 1:
                    col_def = f"{name} {col_type} PRIMARY KEY"
                if notnull and "PRIMARY KEY" not in col_def:
                    col_def += " NOT NULL"
                if default is not None and "PRIMARY KEY" not in col_def:
                    col_def += f" DEFAULT {default}"

            col_defs.append(col_def)
            col_names.append(name)

        quoted_cols = ", ".join(col_names)
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute(f"CREATE TABLE categorias_new ({', '.join(col_defs)})")
            conn.execute(
                f"INSERT INTO categorias_new ({quoted_cols}) SELECT {quoted_cols} FROM categorias"
            )
            conn.execute("DROP TABLE categorias")
            conn.execute("ALTER TABLE categorias_new RENAME TO categorias")
            for idx in index_rows:
                if idx["sql"]:
                    conn.execute(str(idx["sql"]))
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_nombre_tipo ON categorias(nombre, tipo)"
            )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

        fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_issues:
            raise sqlite3.IntegrityError("foreign_key_check detecto inconsistencias luego de migrar categorias.")

        self._append_startup_log("Migracion de categorias finalizada correctamente.")

    def _recreate_categorias_validation_triggers(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            DROP TRIGGER IF EXISTS trg_categorias_validate_insert;
            CREATE TRIGGER trg_categorias_validate_insert
            BEFORE INSERT ON categorias
            FOR EACH ROW
            BEGIN
                SELECT CASE
                    WHEN trim(NEW.nombre) = '' THEN RAISE(ABORT, 'Nombre de categoria obligatorio')
                END;
                SELECT CASE
                    WHEN NEW.tipo NOT IN ('ingreso', 'gasto', 'ahorro', 'inversion') THEN RAISE(ABORT, 'Tipo de categoria invalido')
                END;
            END;

            DROP TRIGGER IF EXISTS trg_categorias_validate_update;
            CREATE TRIGGER trg_categorias_validate_update
            BEFORE UPDATE ON categorias
            FOR EACH ROW
            BEGIN
                SELECT CASE
                    WHEN trim(NEW.nombre) = '' THEN RAISE(ABORT, 'Nombre de categoria obligatorio')
                END;
                SELECT CASE
                    WHEN NEW.tipo NOT IN ('ingreso', 'gasto', 'ahorro', 'inversion') THEN RAISE(ABORT, 'Tipo de categoria invalido')
                END;
            END;
            """
        )

    def _migrate_movimientos_allow_ahorro(self, conn: sqlite3.Connection) -> None:
        create_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='movimientos'"
        ).fetchone()
        if not create_sql or not create_sql[0]:
            return
        sql_text = str(create_sql[0]).lower()
        if "'ahorro'" in sql_text and "'inversion'" in sql_text:
            return
        conn.executescript(
            """
            PRAGMA foreign_keys = OFF;
            CREATE TABLE IF NOT EXISTS movimientos_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha TEXT NOT NULL,
                tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                categoria_id INTEGER NOT NULL,
                descripcion TEXT,
                monto REAL NOT NULL CHECK(monto >= 0),
                FOREIGN KEY (categoria_id) REFERENCES categorias(id)
            );
            INSERT INTO movimientos_new (id, fecha, tipo, categoria_id, descripcion, monto)
            SELECT id, fecha, tipo, categoria_id, descripcion, monto FROM movimientos;
            DROP TABLE movimientos;
            ALTER TABLE movimientos_new RENAME TO movimientos;
            PRAGMA foreign_keys = ON;
            """
        )

    def _backup_before_risky_migrations(self, conn: sqlite3.Connection) -> None:
        create_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='movimientos'"
        ).fetchone()
        if not create_sql or not create_sql[0]:
            return
        sql_text = str(create_sql[0]).lower()
        requires_rebuild = "'ahorro'" not in sql_text or "'inversion'" not in sql_text
        if not requires_rebuild:
            return
        backup_dir = get_backup_dir()
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
            target = backup_dir / f"finanzas_backup_pre_migration_{stamp}.db"
            shutil.copy2(self.db_path, target)
        except OSError:
            # No bloquear la app por permisos de backup en tiempo de inicio.
            return

    def _backup_before_categories_type_migration(self) -> None:
        backup_dir = get_backup_dir()
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
            target = backup_dir / f"finanzas_backup_pre_category_type_migration_{stamp}.db"
            shutil.copy2(self.db_path, target)
            self._append_startup_log(f"Backup pre-migracion de categorias: {target}")
        except OSError as exc:
            self._append_startup_log(f"No se pudo crear backup pre-migracion de categorias: {exc}")

    def _append_startup_log(self, message: str) -> None:
        log_dir = get_logs_dir()
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / "backend-startup.log"
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(f"{timestamp} {message}\n")
        except OSError:
            pass

    def _migrate_movimientos_meta_y_nota(self, conn: sqlite3.Connection) -> None:
        cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(movimientos)").fetchall()
        }
        if "meta_id" not in cols:
            conn.execute(
                "ALTER TABLE movimientos ADD COLUMN meta_id INTEGER REFERENCES metas_ahorro(id)"
            )
        if "nota" not in cols:
            conn.execute("ALTER TABLE movimientos ADD COLUMN nota TEXT")

    def _migrate_sync_columns(self, conn: sqlite3.Connection) -> None:
        user_tables = [
            "movimientos",
            "categorias",
            "presupuestos",
            "metas_ahorro",
            "gastos_fijos",
            "gastos_programados",
            "tags",
            "movimiento_tags",
        ]
        existing_tables = {
            str(row["name"])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table in user_tables:
            if table not in existing_tables:
                continue
            self._ensure_sync_columns_for_table(conn, table)

    def _migrate_owner_columns(self, conn: sqlite3.Connection) -> None:
        user_tables = [
            "movimientos",
            "categorias",
            "presupuestos",
            "metas_ahorro",
            "gastos_fijos",
            "gastos_programados",
            "tags",
            "movimiento_tags",
            "sync_history",
            "sync_conflicts",
        ]
        existing_tables = {
            str(row["name"])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table in user_tables:
            if table not in existing_tables:
                continue
            columns = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if "owner_user_id" not in columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_user_id TEXT")
            conn.execute(
                f"UPDATE {table} SET owner_user_id = 'local' WHERE owner_user_id IS NULL OR trim(owner_user_id) = ''"
            )
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_owner_user_id ON {table}(owner_user_id)")
        if "categorias" in existing_tables:
            self._rebuild_categorias_owner_unique(conn)
            self._recreate_categorias_validation_triggers(conn)

    def _rebuild_categorias_owner_unique(self, conn: sqlite3.Connection) -> None:
        create_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='categorias'"
        ).fetchone()
        if not create_sql or not create_sql[0]:
            return
        sql_text = str(create_sql[0]).lower()
        if "unique(owner_user_id,nombre,tipo)" in sql_text.replace(" ", ""):
            return

        table_info = conn.execute("PRAGMA table_info(categorias)").fetchall()
        if not table_info:
            return
        rows = conn.execute("SELECT * FROM categorias").fetchall()
        old_foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute(
                """
                CREATE TABLE categorias_owner_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                    sync_id TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    deleted_at TEXT,
                    sync_status TEXT,
                    last_synced_at TEXT,
                    last_remote_device_id TEXT,
                    last_remote_device_name TEXT,
                    last_remote_updated_at TEXT,
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
                    UNIQUE(owner_user_id, nombre, tipo)
                )
                """
            )
            new_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(categorias_owner_new)").fetchall()}
            old_columns = [str(row["name"]) for row in table_info]
            shared = [name for name in old_columns if name in new_columns]
            if "owner_user_id" not in shared and "owner_user_id" in new_columns:
                shared.append("owner_user_id")
            for row in rows:
                values = []
                for column in shared:
                    if column in row.keys():
                        values.append(row[column])
                    elif column == "owner_user_id":
                        values.append("local")
                    else:
                        values.append(None)
                placeholders = ", ".join(["?"] * len(shared))
                conn.execute(
                    f"INSERT OR IGNORE INTO categorias_owner_new ({', '.join(shared)}) VALUES ({placeholders})",
                    tuple(values),
                )
            conn.execute("DROP TABLE categorias")
            conn.execute("ALTER TABLE categorias_owner_new RENAME TO categorias")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_owner_nombre_tipo ON categorias(owner_user_id, nombre, tipo)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_categorias_owner_user_id ON categorias(owner_user_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_categorias_sync_status ON categorias(sync_status)")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_sync_id ON categorias(sync_id) WHERE sync_id IS NOT NULL")
        finally:
            conn.execute(f"PRAGMA foreign_keys = {int(old_foreign_keys)}")

    def _ensure_sync_columns_for_table(self, conn: sqlite3.Connection, table: str) -> None:
        columns = {
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        sync_columns = {
            "sync_id": "TEXT",
            "created_at": "TEXT",
            "updated_at": "TEXT",
            "deleted_at": "TEXT",
            "sync_status": "TEXT",
            "last_synced_at": "TEXT",
            "last_remote_device_id": "TEXT",
            "last_remote_device_name": "TEXT",
            "last_remote_updated_at": "TEXT",
        }
        for name, definition in sync_columns.items():
            if name not in columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                columns.add(name)

        now = datetime.now().isoformat(timespec="seconds")
        conn.execute(
            f"UPDATE {table} SET created_at = COALESCE(NULLIF(created_at, ''), ?) WHERE created_at IS NULL OR trim(created_at) = ''",
            (now,),
        )
        conn.execute(
            f"UPDATE {table} SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, ?) WHERE updated_at IS NULL OR trim(updated_at) = ''",
            (now,),
        )
        conn.execute(
            f"UPDATE {table} SET deleted_at = NULL WHERE deleted_at = ''",
        )
        conn.execute(
            f"UPDATE {table} SET sync_status = 'pending' WHERE sync_status IS NULL OR trim(sync_status) = ''",
        )

        id_columns = [
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
            if int(row["pk"] or 0) > 0
        ]
        selector = ", ".join(id_columns)
        if id_columns:
            rows = conn.execute(
                f"SELECT {selector} FROM {table} WHERE sync_id IS NULL OR trim(sync_id) = ''"
            ).fetchall()
            where = " AND ".join([f"{col} = ?" for col in id_columns])
            for row in rows:
                conn.execute(
                    f"UPDATE {table} SET sync_id = ? WHERE {where}",
                    (str(uuid.uuid4()), *[row[col] for col in id_columns]),
                )
        else:
            rows = conn.execute(
                f"SELECT rowid AS _rowid FROM {table} WHERE sync_id IS NULL OR trim(sync_id) = ''"
            ).fetchall()
            for row in rows:
                conn.execute(
                    f"UPDATE {table} SET sync_id = ? WHERE rowid = ?",
                    (str(uuid.uuid4()), row["_rowid"]),
                )

        conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_sync_id ON {table}(sync_id) WHERE sync_id IS NOT NULL"
        )
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_sync_status ON {table}(sync_status)")

    def _seed_default_tags(self, conn: sqlite3.Connection) -> None:
        defaults = [
            ("tarjeta", "#2563eb"),
            ("efectivo", "#16a34a"),
            ("mercadopago", "#0284c7"),
            ("iglesia", "#9333ea"),
            ("trabajo", "#f59e0b"),
            ("delivery", "#dc2626"),
            ("facultad", "#4f46e5"),
        ]
        conn.executemany(
            """
            INSERT OR IGNORE INTO tags (nombre, color)
            VALUES (?, ?)
            """,
            defaults,
        )

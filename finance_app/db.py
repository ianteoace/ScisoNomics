from __future__ import annotations

from datetime import datetime
from pathlib import Path
from contextlib import closing
import sqlite3
import uuid

from .paths import ensure_app_data_layout, get_backup_dir, get_db_path, get_logs_dir

DB_PATH = get_db_path()
CURRENT_SCHEMA_VERSION = "3"


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        # sqlite3 confirma o revierte la transaccion en __exit__, pero no cierra
        # el handle. Cerrar despues evita locks residuales en restore e instalacion.
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class Database:
    def __init__(self, db_path: Path | None = None) -> None:
        ensure_app_data_layout()
        self.db_path = db_path or DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30, factory=ClosingConnection)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def init_db(self) -> None:
        with self.connect() as conn:
            try:
                self._migrate_movimientos_allow_ahorro(conn)
                conn.executescript(
                    """
                CREATE TABLE IF NOT EXISTS categorias (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
                    UNIQUE(owner_user_id, nombre, tipo)
                );

                CREATE TABLE IF NOT EXISTS movimientos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fecha TEXT NOT NULL,
                    tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion')),
                    categoria_id INTEGER NOT NULL,
                    descripcion TEXT,
                    monto REAL NOT NULL CHECK(monto >= 0),
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id)
                );

                CREATE TABLE IF NOT EXISTS gastos_fijos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    categoria_id INTEGER NOT NULL,
                    descripcion TEXT,
                    monto REAL NOT NULL CHECK(monto >= 0),
                    dia_vencimiento INTEGER NOT NULL CHECK(dia_vencimiento BETWEEN 1 AND 31),
                    activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
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
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
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
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
                    FOREIGN KEY (categoria_id) REFERENCES categorias(id),
                    UNIQUE(owner_user_id, categoria_id, mes, anio)
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
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    owner_user_id TEXT NOT NULL DEFAULT 'local'
                );

                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    color TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    owner_user_id TEXT NOT NULL DEFAULT 'local',
                    UNIQUE(owner_user_id, nombre)
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
                self._migrate_categorias_owner_unique(conn)
                self._migrate_tags_owner_unique(conn)
                self._migrate_presupuestos_owner_unique(conn)
                self._seed_default_categories(conn)
                self._ensure_required_movement_categories(conn)
                self._seed_default_tags(conn)
                self._set_schema_version(conn)
            except sqlite3.OperationalError as exc:
                if "readonly" in str(exc).lower():
                    return
                raise

    def _set_schema_version(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            INSERT INTO app_config (key, value, updated_at)
            VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (CURRENT_SCHEMA_VERSION,),
        )

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
        conn.executemany(
            "INSERT OR IGNORE INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')",
            defaults,
        )

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
                "INSERT OR IGNORE INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')",
                ("Ahorro", "ahorro"),
            )
        if int(tipo_inversion[0] or 0) == 0:
            conn.execute(
                "INSERT OR IGNORE INTO categorias (nombre, tipo, owner_user_id) VALUES (?, ?, 'local')",
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

        self._create_required_migration_backup("categorias_extended_types")
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

        quoted_cols = ", ".join(self._quote_identifier(column) for column in col_names)
        if conn.in_transaction:
            conn.commit()
        old_foreign_keys = int(conn.execute("PRAGMA foreign_keys").fetchone()[0] or 0)
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute("BEGIN")
            conn.execute(f"CREATE TABLE categorias_new ({', '.join(col_defs)})")
            conn.execute(
                f"INSERT INTO categorias_new ({quoted_cols}) SELECT {quoted_cols} FROM categorias"
            )
            conn.execute("DROP TABLE categorias")
            conn.execute("ALTER TABLE categorias_new RENAME TO categorias")
            for idx in index_rows:
                sql = str(idx["sql"] or "")
                normalized_sql = sql.lower().replace(" ", "")
                if sql and not ("uniqueindex" in normalized_sql and "(nombre,tipo)" in normalized_sql):
                    conn.execute(sql)
            fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk_issues:
                raise sqlite3.IntegrityError("foreign_key_check detecto inconsistencias luego de migrar categorias.")
            conn.commit()
        except Exception:
            conn.rollback()
            self._append_startup_log("Fallo migracion categorias_extended_types. Se hizo rollback.")
            raise
        finally:
            conn.execute(f"PRAGMA foreign_keys = {old_foreign_keys}")

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
        self._create_required_migration_backup("movimientos_extended_types")
        self._append_startup_log("Iniciando migracion segura de movimientos para tipos ahorro/inversion.")
        table_info = conn.execute("PRAGMA table_info(movimientos)").fetchall()
        if not table_info:
            return
        index_rows = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='movimientos' AND sql IS NOT NULL"
        ).fetchall()
        columns = [str(row["name"]) for row in table_info]
        col_defs: list[str] = []
        for row in table_info:
            name = str(row["name"])
            col_type = str(row["type"] or "TEXT")
            notnull = int(row["notnull"] or 0) == 1
            default = row["dflt_value"]
            pk = int(row["pk"] or 0)
            if name == "id":
                col_defs.append("id INTEGER PRIMARY KEY AUTOINCREMENT")
            elif name == "tipo":
                col_defs.append("tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion'))")
            elif name == "categoria_id":
                col_defs.append("categoria_id INTEGER NOT NULL")
            elif name == "monto":
                col_defs.append("monto REAL NOT NULL CHECK(monto >= 0)")
            else:
                col_def = f"{self._quote_identifier(name)} {col_type}".strip()
                if pk:
                    col_def += " PRIMARY KEY"
                if notnull and not pk:
                    col_def += " NOT NULL"
                if default is not None and not pk:
                    col_def += f" DEFAULT {default}"
                col_defs.append(col_def)
        col_defs.append("FOREIGN KEY (categoria_id) REFERENCES categorias(id)")
        quoted_cols = ", ".join(self._quote_identifier(column) for column in columns)

        if conn.in_transaction:
            conn.commit()
        old_foreign_keys = int(conn.execute("PRAGMA foreign_keys").fetchone()[0] or 0)
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute("BEGIN")
            conn.execute(f"CREATE TABLE movimientos_new ({', '.join(col_defs)})")
            conn.execute(
                f"INSERT INTO movimientos_new ({quoted_cols}) SELECT {quoted_cols} FROM movimientos"
            )
            conn.execute("DROP TABLE movimientos")
            conn.execute("ALTER TABLE movimientos_new RENAME TO movimientos")
            for idx in index_rows:
                sql = str(idx["sql"] or "")
                if not sql:
                    continue
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError as exc:
                    self._append_startup_log(f"No se pudo recrear indice de movimientos {idx['name']}: {exc}")
            fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk_issues:
                raise sqlite3.IntegrityError("foreign_key_check detecto inconsistencias luego de migrar movimientos.")
            conn.commit()
        except Exception:
            conn.rollback()
            self._append_startup_log("Fallo migracion de movimientos para tipos ahorro/inversion. Se hizo rollback.")
            raise
        finally:
            conn.execute(f"PRAGMA foreign_keys = {old_foreign_keys}")

        self._append_startup_log("Migracion segura de movimientos finalizada correctamente.")

    def _create_required_migration_backup(self, reason: str) -> Path:
        backup_dir = get_backup_dir()
        target: Path | None = None
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            target = backup_dir / f"finanzas_backup_pre_migration_{reason}_{stamp}_{uuid.uuid4().hex[:8]}.db"
            with closing(sqlite3.connect(self.db_path, timeout=30)) as source:
                with closing(sqlite3.connect(target, timeout=30)) as destination:
                    source.backup(destination)
            if not target.exists() or target.stat().st_size <= 0:
                raise OSError("El backup previo quedo vacio.")
            self._append_startup_log(f"Backup obligatorio creado. reason={reason} file={target.name}")
            return target
        except Exception as exc:
            if target is not None:
                target.unlink(missing_ok=True)
            self._append_startup_log(f"Backup obligatorio fallo. reason={reason} error_type={type(exc).__name__}")
            raise RuntimeError("No se pudo crear el backup obligatorio previo a la migracion.") from exc

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
            tags_backup_created = False
            if table == "tags" and "owner_user_id" not in columns:
                if conn.in_transaction:
                    conn.commit()
                self._create_required_migration_backup("tags_owner_column")
                tags_backup_created = True
            if "owner_user_id" not in columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_user_id TEXT")
                columns.add("owner_user_id")
            if table == "tags" and self._tags_have_effective_owner_duplicates(conn):
                if conn.in_transaction:
                    conn.commit()
                if not tags_backup_created:
                    self._create_required_migration_backup("tags_owner_normalization")
                self._rename_duplicate_tags(conn, use_effective_owner=True)
            conn.execute(
                f"UPDATE {table} SET owner_user_id = 'local' WHERE owner_user_id IS NULL OR trim(owner_user_id) = ''"
            )
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_owner_user_id ON {table}(owner_user_id)")
        if "categorias" in existing_tables:
            self._ensure_categorias_owner_indexes(conn)
            self._recreate_categorias_validation_triggers(conn)
        fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_issues:
            self._append_startup_log(f"foreign_key_check detecto inconsistencias luego de owner migration: {fk_issues}")
            raise sqlite3.IntegrityError("foreign_key_check detecto inconsistencias luego de owner migration.")

    def _migrate_categorias_owner_unique(self, conn: sqlite3.Connection) -> None:
        if not self._categorias_has_global_unique(conn):
            self._ensure_categorias_owner_indexes(conn)
            return

        if conn.in_transaction:
            conn.commit()
        self._create_required_migration_backup("categorias_owner_unique")
        self._append_startup_log("Iniciando migracion de categorias a UNIQUE(owner_user_id, nombre, tipo).")

        table_info = conn.execute("PRAGMA table_info(categorias)").fetchall()
        if not table_info:
            return

        existing_columns = [str(row["name"]) for row in table_info]
        if "owner_user_id" not in existing_columns:
            conn.execute("ALTER TABLE categorias ADD COLUMN owner_user_id TEXT")
            conn.execute("UPDATE categorias SET owner_user_id = 'local' WHERE owner_user_id IS NULL OR trim(owner_user_id) = ''")
            table_info = conn.execute("PRAGMA table_info(categorias)").fetchall()
            existing_columns = [str(row["name"]) for row in table_info]

        index_rows = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='categorias' AND sql IS NOT NULL"
        ).fetchall()
        rows = conn.execute("SELECT * FROM categorias ORDER BY id").fetchall()
        col_defs = [self._categoria_column_definition(row) for row in table_info]
        col_defs.append("UNIQUE(owner_user_id, nombre, tipo)")
        quoted_cols = ", ".join(self._quote_identifier(column) for column in existing_columns)
        placeholders = ", ".join(["?"] * len(existing_columns))

        if conn.in_transaction:
            conn.commit()

        old_foreign_keys = int(conn.execute("PRAGMA foreign_keys").fetchone()[0] or 0)
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute("BEGIN")
            conn.execute(f"CREATE TABLE categorias_owner_new ({', '.join(col_defs)})")
            seen_keys: set[tuple[str, str, str]] = set()
            for row in rows:
                values = []
                owner = str(row["owner_user_id"] or "local").strip() or "local"
                nombre = str(row["nombre"] or "").strip()
                tipo = str(row["tipo"] or "").strip()
                key = (owner, nombre, tipo)
                if key in seen_keys:
                    nombre = f"{nombre} #{row['id']}"
                    key = (owner, nombre, tipo)
                seen_keys.add(key)

                for column in existing_columns:
                    if column == "owner_user_id":
                        values.append(owner)
                    elif column == "nombre":
                        values.append(nombre)
                    else:
                        values.append(row[column])
                conn.execute(
                    f"INSERT INTO categorias_owner_new ({quoted_cols}) VALUES ({placeholders})",
                    tuple(values),
                )
            conn.execute("DROP TABLE categorias")
            conn.execute("ALTER TABLE categorias_owner_new RENAME TO categorias")
            self._recreate_categorias_indexes_after_owner_unique(conn, index_rows)
            fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk_issues:
                raise sqlite3.IntegrityError("foreign_key_check detecto inconsistencias luego de migrar unique owner categorias.")
            conn.commit()
        except Exception:
            conn.rollback()
            self._append_startup_log("Fallo migracion unique owner categorias. Se hizo rollback.")
            raise
        finally:
            conn.execute(f"PRAGMA foreign_keys = {old_foreign_keys}")

        self._append_startup_log("Migracion unique owner categorias finalizada correctamente.")

    def _categorias_has_global_unique(self, conn: sqlite3.Connection) -> bool:
        return self._has_unique_index(conn, "categorias", ("nombre", "tipo"))

    def _categoria_column_definition(self, row: sqlite3.Row) -> str:
        name = str(row["name"])
        col_type = str(row["type"] or "TEXT")
        notnull = int(row["notnull"] or 0) == 1
        default = row["dflt_value"]
        pk = int(row["pk"] or 0)

        if name == "id":
            return "id INTEGER PRIMARY KEY AUTOINCREMENT"
        if name == "tipo":
            return "tipo TEXT NOT NULL CHECK(tipo IN ('ingreso', 'gasto', 'ahorro', 'inversion'))"
        if name == "owner_user_id":
            return "owner_user_id TEXT NOT NULL DEFAULT 'local'"

        col_def = f"{self._quote_identifier(name)} {col_type}".strip()
        if pk:
            col_def += " PRIMARY KEY"
        if notnull and not pk:
            col_def += " NOT NULL"
        if default is not None and not pk:
            col_def += f" DEFAULT {default}"
        return col_def

    def _recreate_categorias_indexes_after_owner_unique(self, conn: sqlite3.Connection, index_rows: list[sqlite3.Row]) -> None:
        for idx in index_rows:
            sql = str(idx["sql"] or "")
            lowered = sql.lower().replace(" ", "")
            if not sql:
                continue
            if "uniqueindex" in lowered and "(nombre,tipo)" in lowered:
                continue
            if "idx_categorias_nombre_tipo" in lowered:
                continue
            if "idx_categorias_owner_nombre_tipo" in lowered:
                continue
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                self._append_startup_log(f"No se pudo recrear indice de categorias {idx['name']}: {exc}")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_owner_nombre_tipo ON categorias(owner_user_id, nombre, tipo)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_categorias_owner_user_id ON categorias(owner_user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_categorias_sync_status ON categorias(sync_status)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_sync_id ON categorias(sync_id) WHERE sync_id IS NOT NULL")

    @staticmethod
    def _quote_identifier(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    def _ensure_categorias_owner_indexes(self, conn: sqlite3.Connection) -> None:
        # El indice fisico incluye tambien soft-deleted; normalizar todos los
        # duplicados evita fallos al crearlo sin borrar ni reasignar IDs.
        duplicates = conn.execute(
            """
            SELECT owner_user_id, nombre, tipo, COUNT(*) AS total
            FROM categorias
            GROUP BY owner_user_id, nombre, tipo
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        for duplicate in duplicates:
            rows = conn.execute(
                """
                SELECT id
                FROM categorias
                WHERE owner_user_id = ? AND nombre = ? AND tipo = ?
                ORDER BY id
                """,
                (duplicate["owner_user_id"], duplicate["nombre"], duplicate["tipo"]),
            ).fetchall()
            for row in rows[1:]:
                conn.execute(
                    """
                    UPDATE categorias
                    SET nombre = nombre || ' #' || id,
                        updated_at = COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP),
                        sync_status = 'pending'
                    WHERE id = ?
                    """,
                    (row["id"],),
                )
        try:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_owner_nombre_tipo ON categorias(owner_user_id, nombre, tipo)"
            )
        except sqlite3.IntegrityError as exc:
            self._append_startup_log(f"No se pudo crear idx_categorias_owner_nombre_tipo: {exc}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_categorias_owner_user_id ON categorias(owner_user_id)")

    def _migrate_tags_owner_unique(self, conn: sqlite3.Connection) -> None:
        if self._has_unique_index(conn, "tags", ("owner_user_id", "nombre")):
            return

        if conn.in_transaction:
            conn.commit()
        self._create_required_migration_backup("tags_owner_unique")
        self._append_startup_log("Iniciando migracion de tags a UNIQUE(owner_user_id, nombre).")
        if self._has_unique_index(conn, "tags", ("nombre",)):
            self._rebuild_owner_unique_table(
                conn,
                table="tags",
                unique_columns=("owner_user_id", "nombre"),
            )
        else:
            self._rename_duplicate_tags(conn)
            conn.execute("CREATE UNIQUE INDEX idx_tags_owner_nombre ON tags(owner_user_id, nombre)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tags_owner_user_id ON tags(owner_user_id)")
        self._append_startup_log("Migracion unique owner tags finalizada correctamente.")

    def _migrate_presupuestos_owner_unique(self, conn: sqlite3.Connection) -> None:
        owner_columns = ("owner_user_id", "categoria_id", "mes", "anio")
        if self._has_unique_index(conn, "presupuestos", owner_columns):
            return

        duplicate_count = int(
            conn.execute(
                """
                SELECT COUNT(*)
                FROM (
                    SELECT 1
                    FROM presupuestos
                    GROUP BY owner_user_id, categoria_id, mes, anio
                    HAVING COUNT(*) > 1
                )
                """
            ).fetchone()[0]
            or 0
        )
        if duplicate_count:
            self._append_startup_log(
                f"No se migro unique owner presupuestos: duplicate_groups={duplicate_count}. Requiere revision manual."
            )
            return

        if conn.in_transaction:
            conn.commit()
        self._create_required_migration_backup("presupuestos_owner_unique")
        self._append_startup_log(
            "Iniciando migracion de presupuestos a UNIQUE(owner_user_id, categoria_id, mes, anio)."
        )
        if self._has_unique_index(conn, "presupuestos", ("categoria_id", "mes", "anio")):
            self._rebuild_owner_unique_table(
                conn,
                table="presupuestos",
                unique_columns=owner_columns,
                table_constraints=(
                    "CHECK(mes BETWEEN 1 AND 12)",
                    "CHECK(monto > 0)",
                    "FOREIGN KEY (categoria_id) REFERENCES categorias(id)",
                ),
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX idx_presupuestos_owner_categoria_periodo "
                "ON presupuestos(owner_user_id, categoria_id, mes, anio)"
            )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_presupuestos_owner_user_id ON presupuestos(owner_user_id)")
        self._append_startup_log("Migracion unique owner presupuestos finalizada correctamente.")

    def _tags_have_effective_owner_duplicates(self, conn: sqlite3.Connection) -> bool:
        row = conn.execute(
            """
            SELECT 1
            FROM tags
            GROUP BY COALESCE(NULLIF(trim(owner_user_id), ''), 'local'), nombre
            HAVING COUNT(*) > 1
            LIMIT 1
            """
        ).fetchone()
        return row is not None

    def _rename_duplicate_tags(self, conn: sqlite3.Connection, *, use_effective_owner: bool = False) -> None:
        owner_expression = "COALESCE(NULLIF(trim(owner_user_id), ''), 'local')" if use_effective_owner else "owner_user_id"
        duplicates = conn.execute(
            f"""
            SELECT {owner_expression} AS effective_owner_user_id, nombre, COUNT(*) AS total
            FROM tags
            GROUP BY {owner_expression}, nombre
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(tags)").fetchall()}
        for duplicate in duplicates:
            rows = conn.execute(
                f"""
                SELECT id
                FROM tags
                WHERE {owner_expression} = ? AND nombre = ?
                ORDER BY id
                """,
                (duplicate["effective_owner_user_id"], duplicate["nombre"]),
            ).fetchall()
            for row in rows[1:]:
                suffix = 1
                candidate = f"{duplicate['nombre']} (duplicado {row['id']})"
                while conn.execute(
                    f"SELECT 1 FROM tags WHERE {owner_expression} = ? AND nombre = ? AND id <> ? LIMIT 1",
                    (duplicate["effective_owner_user_id"], candidate, row["id"]),
                ).fetchone():
                    suffix += 1
                    candidate = f"{duplicate['nombre']} (duplicado {row['id']}-{suffix})"
                assignments = ["nombre = ?"]
                params: list[object] = [candidate]
                if "updated_at" in columns:
                    assignments.append("updated_at = COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP)")
                if "sync_status" in columns:
                    assignments.append("sync_status = 'pending'")
                params.append(row["id"])
                conn.execute(
                    f"""
                    UPDATE tags
                    SET {", ".join(assignments)}
                    WHERE id = ?
                    """,
                    tuple(params),
                )
        if duplicates:
            self._append_startup_log(f"Tags duplicados renombrados de forma conservadora. groups={len(duplicates)}")

    def _rebuild_owner_unique_table(
        self,
        conn: sqlite3.Connection,
        *,
        table: str,
        unique_columns: tuple[str, ...],
        table_constraints: tuple[str, ...] = (),
    ) -> None:
        table_info = conn.execute(f"PRAGMA table_info({self._quote_identifier(table)})").fetchall()
        existing_columns = [str(row["name"]) for row in table_info]
        index_rows = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
            (table,),
        ).fetchall()
        if table == "tags":
            self._rename_duplicate_tags(conn)

        col_defs = [self._generic_column_definition(row) for row in table_info]
        col_defs.extend(table_constraints)
        col_defs.append(f"UNIQUE({', '.join(unique_columns)})")
        quoted_cols = ", ".join(self._quote_identifier(column) for column in existing_columns)
        new_table = f"{table}_owner_new"

        if conn.in_transaction:
            conn.commit()
        old_foreign_keys = int(conn.execute("PRAGMA foreign_keys").fetchone()[0] or 0)
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute("BEGIN")
            conn.execute(f"CREATE TABLE {self._quote_identifier(new_table)} ({', '.join(col_defs)})")
            conn.execute(
                f"INSERT INTO {self._quote_identifier(new_table)} ({quoted_cols}) "
                f"SELECT {quoted_cols} FROM {self._quote_identifier(table)}"
            )
            conn.execute(f"DROP TABLE {self._quote_identifier(table)}")
            conn.execute(
                f"ALTER TABLE {self._quote_identifier(new_table)} RENAME TO {self._quote_identifier(table)}"
            )
            for index in index_rows:
                sql = str(index["sql"] or "")
                if not sql or "unique" in sql.lower():
                    continue
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError as exc:
                    self._append_startup_log(f"No se pudo recrear indice de {table} {index['name']}: {exc}")
            fk_issues = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk_issues:
                raise sqlite3.IntegrityError(f"foreign_key_check detecto inconsistencias luego de migrar {table}.")
            conn.commit()
        except Exception:
            conn.rollback()
            self._append_startup_log(f"Fallo migracion unique owner {table}. Se hizo rollback.")
            raise
        finally:
            conn.execute(f"PRAGMA foreign_keys = {old_foreign_keys}")

    def _generic_column_definition(self, row: sqlite3.Row) -> str:
        name = str(row["name"])
        col_type = str(row["type"] or "TEXT")
        default = row["dflt_value"]
        pk = int(row["pk"] or 0)
        definition = f"{self._quote_identifier(name)} {col_type}".strip()
        if name == "id" and pk:
            return "id INTEGER PRIMARY KEY AUTOINCREMENT"
        if pk:
            definition += " PRIMARY KEY"
        if int(row["notnull"] or 0) == 1 and not pk:
            definition += " NOT NULL"
        if default is not None and not pk:
            definition += f" DEFAULT {default}"
        return definition

    def _has_unique_index(self, conn: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> bool:
        for index in conn.execute(f"PRAGMA index_list({self._quote_identifier(table)})").fetchall():
            if int(index["unique"] or 0) != 1:
                continue
            indexed_columns = tuple(
                str(row["name"])
                for row in conn.execute(
                    f"PRAGMA index_info({self._quote_identifier(str(index['name']))})"
                ).fetchall()
            )
            if indexed_columns == columns:
                return True
        return False

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

import asyncio
from contextlib import closing
import os
import logging
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from finance_app.db import Database
from finance_app.services import FinanceService
from finance_app.restore_validation import copy_restore_source, open_restore_source
from finance_app.secure_backup import MAGIC, encrypt_backup, decrypt_backup


class RestoreValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.layout = patch("finance_app.db.ensure_app_data_layout")
        self.layout.start()
        self.addCleanup(self.layout.stop)
        self.db = Database(self.root / "active.db")
        self.db.init_db()
        self.service = FinanceService(self.db)
        self.source = self.service.backup_database(self.root / "backups")

    def assertRejected(self, path):
        before = self.db.db_path.read_bytes()
        with self.assertRaises(ValueError):
            self.service.restore_database_from_path(path, self.root / "safety")
        self.assertEqual(before, self.db.db_path.read_bytes())

    def test_valid_sqlite_restore_preserves_safety_copy(self):
        safety = self.service.restore_database_from_path(self.source, self.root / "safety")
        self.assertTrue(safety.is_file())
        with closing(sqlite3.connect(self.db.db_path)) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_encrypted_v1_backup_roundtrip_and_restore(self):
        encrypted = encrypt_backup(self.source, self.root / "valid.sciso-backup", "synthetic-backup-passphrase")
        snapshot = self.root / "snapshot.sciso-backup"
        self.assertEqual(copy_restore_source(encrypted, snapshot, allow_encrypted=True), "encrypted")
        clear = decrypt_backup(snapshot, self.root / "clear.db", "synthetic-backup-passphrase")
        self.service.restore_database_from_path(clear, self.root / "safety")
        self.assertEqual(clear.read_bytes(), self.db.db_path.read_bytes())

    def test_missing_file(self):
        self.assertRejected(self.root / "missing.db")

    def test_directory(self):
        directory = self.root / "directory.db"
        directory.mkdir()
        self.assertRejected(directory)

    def test_relative_path(self):
        self.assertRejected(Path("relative.db"))

    def test_invalid_magic(self):
        fake = self.root / "fake.db"
        fake.write_bytes(b"not a SQLite database")
        self.assertRejected(fake)

    def test_sqlite_with_incompatible_schema(self):
        fake = self.root / "foreign.db"
        with closing(sqlite3.connect(fake)) as conn:
            conn.execute("CREATE TABLE other (id INTEGER)")
            conn.commit()
        self.assertRejected(fake)

    def test_oversize_file(self):
        with patch("finance_app.restore_validation.MAX_BACKUP_BYTES", self.source.stat().st_size - 1):
            self.assertRejected(self.source)

    def test_unsupported_extension(self):
        fake = self.root / "backup.txt"
        fake.write_bytes(self.source.read_bytes())
        self.assertRejected(fake)

    def test_truncated_or_unknown_encrypted_header(self):
        for content in (MAGIC, b"SCISONOMICS_BACKUP_V2\n" + b"x" * 80):
            fake = self.root / "invalid.sciso-backup"
            fake.write_bytes(content)
            with self.assertRaises(ValueError):
                with open_restore_source(fake, allow_encrypted=True):
                    pass

    def test_symlink_file_and_parent_rejected(self):
        link = self.root / "link.db"
        try:
            link.symlink_to(self.source)
        except OSError:
            self.skipTest("Creating Windows symlinks requires developer mode or privilege")
        self.assertRejected(link)
        parent = self.root / "linked-folder"
        parent.symlink_to(self.source.parent, target_is_directory=True)
        self.assertRejected(parent / self.source.name)

    def test_windows_reparse_attribute_rejected(self):
        real_lstat = Path.lstat
        def marked(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            if path == self.source:
                return Mock(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with patch.object(Path, "lstat", marked):
            self.assertRejected(self.source)

    def test_handle_is_closed(self):
        with open_restore_source(self.source) as (handle, kind):
            self.assertEqual(kind, "sqlite")
        self.assertTrue(handle.closed)

    def test_endpoint_plain_and_encrypted_backups(self):
        # Isolate module initialization from real application data and logs.
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}), patch("finance_app.paths.ensure_app_data_layout"), patch("logging.FileHandler", return_value=logging.NullHandler()):
            from modern_app.backend.app import main
        encrypted = encrypt_backup(self.source, self.root / "valid.sciso-backup", "synthetic-backup-passphrase")
        for source in (self.source, encrypted):
            request = Mock(json=AsyncMock(return_value={"source_path": str(source), "passphrase": "synthetic-backup-passphrase"}))
            with patch.object(main, "ensure_app_data_initialized"), patch.object(main, "invalidate_app_data_initialized"), patch.object(main, "get_data_dir", return_value=self.root):
                result = asyncio.run(main.restore_backup(request, self.service))
            self.assertTrue(result["ok"])
            self.assertEqual(result["safety_backup"], Path(result["safety_backup"]).name)

    def test_endpoint_rejects_invalid_paths_without_exposing_paths(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}), patch("logging.FileHandler", return_value=logging.NullHandler()):
            from modern_app.backend.app import main
        from fastapi import HTTPException
        before = self.db.db_path.read_bytes()
        fake = self.root / "fake.db"
        fake.write_bytes(b"invalid SQLite magic")
        for source in (self.root / "missing.db", Path("relative.db"), fake):
            request = Mock(json=AsyncMock(return_value={"source_path": str(source)}))
            with patch.object(main, "ensure_app_data_initialized"):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(main.restore_backup(request, self.service))
            self.assertEqual(caught.exception.status_code, 400)
            self.assertNotIn(str(source), caught.exception.detail)
            self.assertEqual(before, self.db.db_path.read_bytes())

    def test_endpoint_wrong_passphrase_does_not_replace_database(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}), patch("logging.FileHandler", return_value=logging.NullHandler()):
            from modern_app.backend.app import main
        from fastapi import HTTPException
        before = self.db.db_path.read_bytes()
        source = encrypt_backup(self.source, self.root / "valid.sciso-backup", "synthetic-backup-passphrase")
        request = Mock(json=AsyncMock(return_value={"source_path": str(source), "passphrase": "incorrect-synthetic-passphrase"}))
        with patch.object(main, "ensure_app_data_initialized"):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(main.restore_backup(request, self.service))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(before, self.db.db_path.read_bytes())


if __name__ == "__main__":
    unittest.main()

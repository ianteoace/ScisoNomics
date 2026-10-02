"""Read-only diagnostic for the historical ScisoNomics cloud owner.

Run manually with SCISONOMICS_CLOUD_DATABASE_URL set to a PostgreSQL URL.
Set HISTORICAL_USER_ID to the verified UUID only in a private local copy;
the published value is a fictitious placeholder. Never commit real user IDs.
No application imports: starting the backend could initialize/migrate its DB.
Stdout contains only the nine allowed users fields, as JSON. Errors are generic
and never include the connection URL, database exception text or credentials.
"""

from contextlib import closing
from datetime import date, datetime
import json
import logging
import os
import sys


HISTORICAL_USER_ID = "00000000-0000-0000-0000-000000000000"
SELECT_USER = """
SELECT id, email, display_name, auth_provider, auth_provider_id,
       email_verified, plan, subscription_status, subscription_expires_at
FROM public.users
WHERE id = %s
"""


def json_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError("Unsupported diagnostic field type")


def main() -> int:
    database_url = os.environ.get("SCISONOMICS_CLOUD_DATABASE_URL", "").strip()
    if not database_url.startswith(("postgresql://", "postgres://")):
        print("Falta SCISONOMICS_CLOUD_DATABASE_URL con una URL PostgreSQL.", file=sys.stderr)
        return 2

    # The driver must not emit connection details, including on failure.
    logging.getLogger("psycopg").disabled = True
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        print("Falta psycopg[binary], incluido en cloud_backend/requirements.txt.", file=sys.stderr)
        return 2

    try:
        with closing(psycopg.connect(
            database_url,
            autocommit=False,
            row_factory=dict_row,
            connect_timeout=10,
            options="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=5000",
            application_name="scisonomics-readonly-user-diagnostic",
        )) as connection:
            connection.read_only = True
            try:
                # The only data query is this parameterized SELECT on users.
                row = connection.execute(SELECT_USER, (HISTORICAL_USER_ID,)).fetchone()
            finally:
                # Never commit, including on successful reads.
                connection.rollback()
        if row is None:
            print("No se encontro el users.id historico en esta base.", file=sys.stderr)
            return 1
        output = json.dumps(row, ensure_ascii=False, indent=2, default=json_value)
    except Exception:
        print("No se pudo completar el SELECT de users; revisar conexion, permisos y columnas.", file=sys.stderr)
        return 2

    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Operator-only retry of ONE already-closed account; never creates a request."""
import argparse
from uuid import UUID
from .account_deletion import external_delete, result
from .db import connect


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-id',required=True)
    args=parser.parse_args()
    identifier=str(UUID(args.request_id))
    with connect() as conn:
        row=conn.execute('SELECT completed_at FROM account_deletion_requests WHERE id=?',(identifier,)).fetchone()
        if not row or not row['completed_at']:parser.error('request is not a completed internal deletion')
    external_delete(identifier)
    with connect() as conn:
        status=result(conn,identifier)
    # No user/provider IDs, token, key, email or provider response.
    print('internal_status='+status['status']+' external_auth_status='+status['external_auth_status'])


if __name__=='__main__':main()

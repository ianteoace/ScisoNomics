"""Operator/cron reconciliation; never takes credentials or tokens on CLI/stdout."""
import argparse
import json
from .db import connect,init_db
from .google_play_api import decrypt_token,PlayError
from .google_play_billing import reconcile_google_play_subscription

def main():
    parser=argparse.ArgumentParser(description="Reconcile verified Google Play subscriptions with configured server credentials.")
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--subscription-id')
    group.add_argument('--all',action='store_true')
    args=parser.parse_args()
    init_db()
    with connect() as conn:
        suffix=' AND id=?' if args.subscription_id else ''
        params=(args.subscription_id,) if args.subscription_id else ()
        active=[dict(r) for r in conn.execute("SELECT * FROM billing_subscriptions WHERE provider='google_play' AND superseded=0"+suffix,params).fetchall()]
        archived=[json.loads(r['commercial_record']) for r in conn.execute("SELECT commercial_record FROM retained_billing_subscriptions WHERE provider='google_play'"+suffix,params).fetchall()]
    succeeded,failures=0,{}
    for row in (*active,*archived):
        try:reconcile_google_play_subscription(decrypt_token(row));succeeded+=1
        except PlayError as exc:failures[exc.code]=failures.get(exc.code,0)+1
    print(json.dumps({'verified':succeeded,'failures':failures}))
    return int(bool(failures))

if __name__=='__main__':raise SystemExit(main())

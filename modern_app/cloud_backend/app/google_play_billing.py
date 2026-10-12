"""Verified Play purchases, generation CAS, archive-safe reconciliation and RTDN."""
from __future__ import annotations
import base64
import hmac
import json
import hashlib
from datetime import datetime,timezone
from uuid import uuid4

from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import account_lifecycle as lifecycle, billing_entitlements as effective, google_play_api as api
from .db import connect
from .security import enforce_rate_limit

STATES={
 "SUBSCRIPTION_STATE_PENDING":"pending","SUBSCRIPTION_STATE_ACTIVE":"active",
 "SUBSCRIPTION_STATE_PAUSED":"paused","SUBSCRIPTION_STATE_IN_GRACE_PERIOD":"grace",
 "SUBSCRIPTION_STATE_ON_HOLD":"hold","SUBSCRIPTION_STATE_CANCELED":"canceled",
 "SUBSCRIPTION_STATE_EXPIRED":"expired","SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":"canceled_pending",
}


def now(): return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def binding_hash(value):return hashlib.sha256(("scisonomics-play-binding-v1:"+value).encode()).hexdigest()


def register_binding(conn,user_id,value):
    conn.execute("INSERT INTO google_play_account_bindings(binding_hash,user_id) VALUES(?,?) ON CONFLICT(binding_hash) DO NOTHING",(binding_hash(value),user_id))


def response_binding(body):
    if not isinstance(body,dict) or body.get("subscriptionState") not in STATES or not isinstance(body.get("lineItems"),list):
        raise api.PlayError("google_play_invalid_response",502)
    try:
        identity=body.get("externalAccountIdentifiers",{}).get("obfuscatedExternalAccountId")
        if identity is None:identity=body.get("outOfAppPurchaseContext",{}).get("expiredExternalAccountIdentifiers",{}).get("obfuscatedExternalAccountId")
        if not isinstance(identity,str) or len(identity)!=64 or any(c not in "0123456789abcdef" for c in identity):raise ValueError()
        return identity
    except (ValueError,TypeError,AttributeError):raise api.PlayError("google_play_purchase_not_owned",409) from None


def find_record(conn,digest):
    row=conn.execute("SELECT * FROM billing_subscriptions WHERE provider='google_play' AND purchase_token_hash=?",(digest,)).fetchone()
    if row:return dict(row),None
    archived=conn.execute("SELECT id,commercial_record FROM retained_billing_subscriptions WHERE provider='google_play' AND provider_subscription_id=?",(digest,)).fetchone()
    if archived:return json.loads(archived["commercial_record"]),archived["id"]
    return None,None


def public_status(conn,user_id):
    row=conn.execute("SELECT status,paid_until,auto_renew,acknowledged FROM billing_subscriptions WHERE user_id=? AND provider='google_play' AND superseded=0 ORDER BY updated_at DESC LIMIT 1",(user_id,)).fetchone()
    return {"status":row["status"] if row else "none","expiresAt":row["paid_until"] if row else None,
            "autoRenew":bool(row["auto_renew"]) if row else False,"acknowledged":bool(row["acknowledged"]) if row else False}


def parse_purchase(body,expected_binding,requested_product=None,*,known_binding=False):
    _,products,plans=api.catalog()
    try:
        state=STATES[body["subscriptionState"]]
        items=body["lineItems"]
        if not isinstance(items,list) or len(items)!=1:raise ValueError()
        item=items[0];product=item["productId"]
        if product not in products or (requested_product and product!=requested_product):raise api.PlayError("google_play_product_mismatch",409)
        if item.get("offerDetails",{}).get("basePlanId") not in plans:raise api.PlayError("google_play_product_mismatch",409)
        identity=body.get("externalAccountIdentifiers",{}).get("obfuscatedExternalAccountId")
        out=body.get("outOfAppPurchaseContext") or {}
        if identity is None:identity=out.get("expiredExternalAccountIdentifiers",{}).get("obfuscatedExternalAccountId")
        # Google removes outOfAppPurchaseContext after acknowledgement. A token
        # already verified and bound in our DB retains that binding; any identity
        # actually returned by Google must still match. Unknown tokens need proof.
        if not (identity is None and known_binding):
            if not isinstance(identity,str) or not hmac.compare_digest(identity,expected_binding):raise api.PlayError("google_play_purchase_not_owned",409)
        expires=effective.date(item.get("expiryTime"))
        if expires is None and state not in {"pending","canceled_pending"}:raise ValueError()
        plan=item.get("autoRenewingPlan")
        if not isinstance(plan,dict):raise ValueError()
        # CANCELED explicitly means every auto-renewing item is non-renewing.
        # Some protobuf JSON responses omit a false boolean; never infer true.
        renew=plan.get("autoRenewEnabled",False if state=="canceled" else None)
        if type(renew) is not bool or (state=="canceled" and renew):raise ValueError()
        ack=body["acknowledgementState"]
        if ack not in {"ACKNOWLEDGEMENT_STATE_PENDING","ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"}:raise ValueError()
        order=item.get("latestSuccessfulOrderId")
        if order is not None and (not isinstance(order,str) or len(order)>160):raise ValueError()
        linked=body.get("linkedPurchaseToken") or out.get("expiredPurchaseToken")
        return {"product_id":product,"status":state,"provider_state":body["subscriptionState"],
                "paid_until":expires.isoformat() if expires else None,"auto_renew":int(renew),
                "acknowledged":int(ack=="ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"),"provider_order_id":order},linked,bool(out)
    except api.PlayError:raise
    except (KeyError,ValueError,TypeError,AttributeError):raise api.PlayError("google_play_invalid_response",502) from None


def generation(conn,digest,event_ms):
    if conn.engine=="sqlite" and not conn._conn.in_transaction:conn.execute("BEGIN IMMEDIATE")
    row=conn.execute("""INSERT INTO google_play_reconciliation_locks(token_hash,generation,updated_at,event_ms)
        VALUES(?,1,?,?) ON CONFLICT(token_hash) DO UPDATE SET generation=google_play_reconciliation_locks.generation+1,
        updated_at=excluded.updated_at,event_ms=CASE WHEN google_play_reconciliation_locks.event_ms<excluded.event_ms
        THEN excluded.event_ms ELSE google_play_reconciliation_locks.event_ms END
        WHERE excluded.event_ms=0 OR google_play_reconciliation_locks.event_ms<=excluded.event_ms
        RETURNING generation""",(digest,now(),event_ms)).fetchone()
    return row["generation"] if row else None


def current_generation(conn,digest):
    if conn.engine=="sqlite" and not conn._conn.in_transaction:conn.execute("BEGIN IMMEDIATE")
    suffix=" FOR UPDATE" if conn.engine=="postgresql" else ""
    return conn.execute("SELECT generation FROM google_play_reconciliation_locks WHERE token_hash=?"+suffix,(digest,)).fetchone()["generation"]


def reconcile_google_play_subscription(token,*,user_id=None,package=None,product=None,event_ms=0,notification_type=None):
    system_reconcile=user_id is None
    configured_package,products,_=api.catalog()
    if package is not None and package!=configured_package:raise api.PlayError("google_play_package_mismatch",422)
    if product is not None and product not in products:raise api.PlayError("google_play_product_mismatch",422)
    digest=api.token_hash(token)
    api.encryption_key()
    initial_body=None;closed_ref=None;proven_binding=None
    with connect() as conn:
        record,archive=find_record(conn,digest)
    if user_id is not None and record is None:
        # An invalid first claimant must not advance the token's generation and
        # invalidate an in-flight validation by its real owner.
        proof=api.get_purchase(configured_package,token)
        identity=response_binding(proof)
        with connect() as conn:
            registered=conn.execute("SELECT user_id FROM google_play_account_bindings WHERE binding_hash=?",(binding_hash(identity),)).fetchone()
        proven_binding=identity if registered and registered["user_id"]==user_id else api.binding(user_id)
        parse_purchase(proof,proven_binding,product)
    if user_id is None and record is None:
        initial_body=api.get_purchase(configured_package,token)
        expected=response_binding(initial_body)
        with connect() as conn:
            registered=conn.execute("SELECT user_id,deletion_ref FROM google_play_account_bindings WHERE binding_hash=?",(binding_hash(expected),)).fetchone()
        if registered is None:return {"status":"unclaimed"}
        user_id,closed_ref=registered["user_id"],registered["deletion_ref"]
    with connect() as conn:
        record,archive=find_record(conn,digest)
        if user_id is not None:
            try:lifecycle.lock_active_user(conn,user_id)
            except HTTPException as exc:
                if not system_reconcile or exc.status_code!=410:raise
                record,archive=find_record(conn,digest)
                if archive:user_id=None
                else:
                    registered=conn.execute("SELECT deletion_ref FROM google_play_account_bindings WHERE binding_hash=?",(binding_hash(response_binding(initial_body)),)).fetchone()
                    if not registered or not registered["deletion_ref"]:raise
                    closed_ref=registered["deletion_ref"];user_id=None
            expected=record["account_binding"] if record else proven_binding or (response_binding(initial_body) if initial_body else api.binding(user_id))
            if not system_reconcile and record and (archive or record["user_id"]!=user_id):raise api.PlayError("google_play_purchase_not_owned",409)
        elif record:
            expected=record["account_binding"]
            if not archive:
                try:lifecycle.lock_active_user(conn,record["user_id"])
                except HTTPException as exc:
                    if exc.status_code!=410:raise
                    record,archive=find_record(conn,digest)
                    if not archive:raise
                    expected=record["account_binding"]
        if event_ms and record and event_ms<record["last_rtdn_event_ms"]:return {"status":"old_notification"}
        claim=generation(conn,digest,event_ms)
        if claim is None:return {"status":"old_notification"}
    body=initial_body or api.get_purchase(configured_package,token)
    if user_id is not None and record is None:
        identity=response_binding(body)
        with connect() as conn:
            registered=conn.execute("SELECT user_id FROM google_play_account_bindings WHERE binding_hash=?",(binding_hash(identity),)).fetchone()
        if registered and registered["user_id"]==user_id:expected=identity
    snapshot,linked,outside=parse_purchase(body,expected,product or (record["product_id"] if record else None),known_binding=record is not None)
    linked_hash=api.token_hash(linked) if linked else None
    if linked_hash==digest:raise api.PlayError("google_play_invalid_response",502)
    eligible=snapshot["status"] in effective.GOOGLE_ACCESS_STATES and effective.date(snapshot["paid_until"])>datetime.now(timezone.utc)
    closed=False
    with connect() as conn:
        record,archive=find_record(conn,digest)
        owner=user_id or (record.get("user_id") if record else None)
        if owner:
            try:lifecycle.lock_active_user(conn,owner)
            except HTTPException as exc:
                if exc.status_code!=410:raise
                closed=True
        if current_generation(conn,digest)!=claim:return {"status":"superseded_response"}
        record,archive=find_record(conn,digest)  # Re-read after waiting for deletion.
        if linked_hash:
            previous,previous_archive=find_record(conn,linked_hash)
            if previous and not hmac.compare_digest(previous["account_binding"],expected):raise api.PlayError("google_play_purchase_not_owned",409)
            if outside and previous is None:raise api.PlayError("google_play_purchase_not_owned",409)
        if record and not hmac.compare_digest(record["account_binding"],expected):raise api.PlayError("google_play_purchase_not_owned",409)
        stamp=now()
        if record:
            # A known token may be reconciled after deletion only in the archive.
            snapshot["acknowledged"]=max(snapshot["acknowledged"],record["acknowledged"])
        if notification_type==13 and snapshot["status"]=="expired":snapshot["status"]="revoked"
        entry={**(record or {}),**snapshot,"package_name":configured_package,"purchase_token_hash":digest,
               "account_binding":expected,"purchase_token_ciphertext":api.encrypt_token(token,configured_package,snapshot["product_id"]),
               "last_rtdn_event_ms":max(event_ms,record["last_rtdn_event_ms"] if record else 0),
               "updated_at":stamp,"last_provider_sync_at":stamp,"superseded":record["superseded"] if record else 0}
        if archive or closed or closed_ref:
            if archive:
                entry.pop("user_id",None)
                conn.execute("UPDATE retained_billing_subscriptions SET commercial_record=? WHERE id=?",(json.dumps(entry),archive))
            else:
                deletion=conn.execute("SELECT id FROM account_deletion_requests WHERE id=? AND completed_at IS NOT NULL",(closed_ref.removeprefix("deleted:"),)).fetchone() if closed_ref else conn.execute("SELECT id FROM account_deletion_requests WHERE user_ref=? AND completed_at IS NOT NULL",(lifecycle.reference(owner),)).fetchone()
                if deletion is None:raise lifecycle.closed()
                entry.update(id=str(uuid4()),provider="google_play",created_at=stamp)
                entry.pop("user_id",None)
                conn.execute("INSERT INTO retained_billing_subscriptions(id,deletion_ref,provider,provider_subscription_id,external_reference_hash,commercial_record,archived_at) VALUES(?,?,'google_play',?,?,?,?)",
                    (entry["id"],"deleted:"+deletion["id"],digest,lifecycle.reference("google_play:"+digest),json.dumps(entry),stamp))
                conn.execute("UPDATE account_deletion_requests SET billing_retained=1 WHERE id=?",(deletion["id"],))
        else:
            register_binding(conn,owner,expected)
            if record is None:
                conn.execute("""INSERT INTO billing_subscriptions(id,user_id,provider,provider_subscription_id,status,external_reference,created_at,updated_at)
                    VALUES(?,?,'google_play',?,'pending',?,?,?)""",(str(uuid4()),owner,digest,"google_play:"+digest,stamp,stamp))
            columns=tuple(snapshot)+("package_name","purchase_token_hash","account_binding","purchase_token_ciphertext","last_rtdn_event_ms","updated_at","last_provider_sync_at")
            conn.execute("UPDATE billing_subscriptions SET "+",".join(c+"=?" for c in columns)+" WHERE provider='google_play' AND provider_subscription_id=?",tuple(entry[c] for c in columns)+(digest,))
            if linked_hash and snapshot["status"] not in {"pending","canceled_pending"}:
                conn.execute("UPDATE billing_subscriptions SET superseded=1 WHERE provider='google_play' AND user_id=? AND purchase_token_hash=?",(owner,linked_hash))
            effective.project(conn,owner,now=stamp)
    if closed and not system_reconcile:raise lifecycle.closed()
    if archive or closed or closed_ref:return {"status":"account_deleted"}
    # Persist validated evidence first. Only a confirmed acknowledgement contributes
    # new Play Premium; failure remains recoverable and never enables it locally.
    if eligible and not entry["acknowledged"]:
        try:
            if outside:api.acknowledge(configured_package,snapshot["product_id"],token,obfuscated_account_id=expected)
            else:api.acknowledge(configured_package,snapshot["product_id"],token)
        except api.PlayError:pass  # A lost response may still have acknowledged it.
        fresh,_,_=parse_purchase(api.get_purchase(configured_package,token),expected,snapshot["product_id"],known_binding=True)
        if not fresh["acknowledged"]:raise api.PlayError("google_play_acknowledgement_pending") from None
        snapshot=fresh
        with connect() as conn:
            row,archived=find_record(conn,digest)
            if not archived:
                try:lifecycle.lock_active_user(conn,owner)
                except HTTPException as exc:
                    if exc.status_code!=410:raise
                    row,archived=find_record(conn,digest)
                    if not archived:raise
            if current_generation(conn,digest)!=claim:return {"status":"superseded_response"}
            row,archived=find_record(conn,digest)
            if archived:
                row.update(snapshot)
                conn.execute("UPDATE retained_billing_subscriptions SET commercial_record=? WHERE id=?",(json.dumps(row),archived))
                return {"status":"account_deleted"}
            columns=tuple(snapshot)
            conn.execute("UPDATE billing_subscriptions SET "+",".join(c+"=?" for c in columns)+" WHERE id=?",tuple(snapshot[c] for c in columns)+(row["id"],))
            effective.project(conn,owner,now=now())
    with connect() as conn:return public_status(conn,owner)


class Purchase(BaseModel):
    model_config=ConfigDict(extra="forbid")
    purchaseToken:str=Field(min_length=1,max_length=4096)
    productId:str=Field(min_length=1,max_length=120)
    packageName:str=Field(min_length=1,max_length=200)


def error(exc):
    message={"google_play_purchase_not_owned":"Esta compra pertenece a otra cuenta ScisoNomics. Usá la cuenta original.",
             "google_play_not_configured":"Las compras con Google Play todavía no están habilitadas. Podés seguir usando el modo local.",
             "google_play_acknowledgement_pending":"La compra todavía no pudo confirmarse. Usá Restaurar compras para reintentar.",
             "google_play_package_mismatch":"Esta instalación no coincide con la app de Google Play."}.get(exc.code,
             "No pudimos verificar la compra con Google Play. Reintentá sin realizar otra compra.")
    return HTTPException(exc.status,detail={"code":exc.code,"message":message})


def register_routes(app,current_user):
    @app.get("/billing/google-play/context")
    def context(user=Depends(current_user)):
        try:
            result=api.configured_context(user.id)
            with connect() as conn:
                lifecycle.lock_active_user(conn,user.id);register_binding(conn,user.id,result["obfuscatedAccountId"])
            return result
        except api.PlayError as exc:raise error(exc) from None

    @app.get("/billing/google-play/subscription")
    def status(user=Depends(current_user)):
        with connect() as conn:return public_status(conn,user.id)

    @app.post("/billing/google-play/validate")
    def validate(payload:Purchase,request:Request,user=Depends(current_user)):
        enforce_rate_limit(request,"google-play-validate",identity=user.id,limit=20,window_seconds=600)
        try:return reconcile_google_play_subscription(payload.purchaseToken,user_id=user.id,package=payload.packageName,product=payload.productId)
        except api.PlayError as exc:raise error(exc) from None

    @app.post("/billing/google-play/refresh")
    def refresh(request:Request,user=Depends(current_user)):
        enforce_rate_limit(request,"google-play-refresh",identity=user.id,limit=10,window_seconds=600)
        with connect() as conn:
            rows=conn.execute("SELECT * FROM billing_subscriptions WHERE provider='google_play' AND user_id=? AND superseded=0",(user.id,)).fetchall()
        try:
            for row in rows:reconcile_google_play_subscription(api.decrypt_token(dict(row)),user_id=user.id,package=row["package_name"],product=row["product_id"])
        except api.PlayError as exc:raise error(exc) from None
        with connect() as conn:return public_status(conn,user.id)

    @app.post("/billing/google-play/rtdn")
    async def rtdn(request:Request,authorization:str|None=Header(default=None)):
        enforce_rate_limit(request,"google-play-rtdn",limit=600,window_seconds=60)
        try:
            subscription=await run_in_threadpool(api.verify_push,authorization)
            raw=await request.body()
            if len(raw)>32768:raise ValueError()
            envelope=json.loads(raw)
            if envelope.get("subscription")!=subscription:raise api.PlayError("google_play_rtdn_unauthorized",401)
            notice=json.loads(base64.b64decode(envelope["message"]["data"],validate=True))
            if notice.get("packageName")!=api.catalog()[0]:raise ValueError()
            if "testNotification" in notice:return {"status":"test_received"}
            info=notice.get("subscriptionNotification") or notice.get("voidedPurchaseNotification")
            if not isinstance(info,dict):raise ValueError()
            event_ms=int(notice["eventTimeMillis"])
            if event_ms<0 or event_ms>int(datetime.now(timezone.utc).timestamp()*1000)+300000:raise ValueError()
            result=await run_in_threadpool(reconcile_google_play_subscription,info["purchaseToken"],event_ms=event_ms,notification_type=info.get("notificationType"))
            return {"status":result["status"]}
        except api.PlayError as exc:raise error(exc) from None
        except (ValueError,TypeError,KeyError,AttributeError):raise HTTPException(400,detail={"code":"google_play_invalid_notification"}) from None

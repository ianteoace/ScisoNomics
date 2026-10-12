"""Official Google APIs, bounded HTTPS transport, server-only credentials."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import quote

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from google.auth.transport import Request as AuthRequest, Response as AuthResponse
from google.oauth2 import id_token, service_account

logger = logging.getLogger(__name__)
# HTTPX's INFO request lines contain the purchase token in Google's URL path.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
OAUTH = "https://oauth2.googleapis.com/token"
CERTS = "https://www.googleapis.com/oauth2/v1/certs"
_auth_lock = threading.Lock()
_credentials = None
_credential_file = None
_cert_cache = None


class PlayError(Exception):
    def __init__(self, code, status=503):
        self.code, self.status = code, status
        super().__init__(code)  # Never include Google URL/body, token or credentials.


def catalog():
    package = os.getenv("SCISONOMICS_GOOGLE_PLAY_PACKAGE_NAME", "com.scisoftware.scisonomics").strip()
    products = tuple(x.strip() for x in os.getenv("SCISONOMICS_GOOGLE_PLAY_PRODUCT_IDS", "scisonomics_premium_monthly").split(",") if x.strip())
    plans = tuple(x.strip() for x in os.getenv("SCISONOMICS_GOOGLE_PLAY_BASE_PLAN_IDS", "monthly").split(",") if x.strip())
    if (not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){2,}", package)
            or not products or not plans or len(products)>20 or len(plans)>20
            or any(not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,119}", x) for x in (*products,*plans))
            or (package.endswith(".debug") and os.getenv("SCISONOMICS_ENV")=="production")):
        raise PlayError("google_play_invalid_config")
    return package, products, plans


def binding(user_id):
    key = os.getenv("SCISONOMICS_GOOGLE_PLAY_BINDING_SECRET", "").encode()
    if len(key)<32:
        raise PlayError("google_play_not_configured")
    return hmac.new(key, ("scisonomics-play-account-v1:"+user_id).encode(), hashlib.sha256).hexdigest()


def token_hash(token):
    if not isinstance(token,str) or not 1<=len(token)<=4096 or any(ord(c)<33 or ord(c)>126 for c in token):
        raise PlayError("google_play_invalid_purchase_token", 422)
    return hashlib.sha256(("scisonomics-play-token-v1:"+token).encode()).hexdigest()


def encryption_key():
    try:
        key = base64.b64decode(os.getenv("SCISONOMICS_GOOGLE_PLAY_TOKEN_ENCRYPTION_KEY", ""), altchars=b"-_", validate=True)
        if len(key)!=32: raise ValueError()
        return key
    except (ValueError, TypeError):
        raise PlayError("google_play_not_configured") from None


def _aad(package, product, digest):
    return ("scisonomics-play-token-v1:"+package+":"+product+":"+digest).encode()


def encrypt_token(token, package, product):
    nonce=secrets.token_bytes(12)
    data=AESGCM(encryption_key()).encrypt(nonce,token.encode(),_aad(package,product,token_hash(token)))
    return "v1:"+base64.urlsafe_b64encode(nonce+data).decode()


def decrypt_token(record):
    try:
        value=record["purchase_token_ciphertext"]
        if not value.startswith("v1:"): raise ValueError()
        data=base64.b64decode(value[3:],altchars=b"-_",validate=True)
        token=AESGCM(encryption_key()).decrypt(data[:12],data[12:],_aad(record["package_name"],record["product_id"],record["purchase_token_hash"])).decode()
        if not hmac.compare_digest(token_hash(token),record["purchase_token_hash"]): raise ValueError()
        return token
    except PlayError:
        raise
    except Exception:
        raise PlayError("google_play_token_unavailable") from None


class Response(AuthResponse):
    def __init__(self, response): self.response=response
    @property
    def status(self): return self.response.status_code
    @property
    def data(self): return self.response.content
    @property
    def headers(self): return self.response.headers


class Transport(AuthRequest):
    def __call__(self,url,method="GET",body=None,headers=None,timeout=10,**kwargs):
        global _cert_cache
        if url not in {OAUTH,CERTS}: raise PlayError("google_play_auth_transport_rejected")
        if url==CERTS and _cert_cache and _cert_cache[0]>time.monotonic(): return _cert_cache[1]
        try:
            response=httpx.request(method,url,content=body,headers=headers,timeout=10,follow_redirects=False)
        except httpx.HTTPError:
            raise PlayError("google_play_provider_unavailable") from None
        if len(response.content)>262144: raise PlayError("google_play_invalid_response",502)
        wrapped=Response(response)
        if url==CERTS and response.status_code==200: _cert_cache=(time.monotonic()+300,wrapped)
        return wrapped


def credentials():
    global _credentials,_credential_file
    filename=os.getenv("SCISONOMICS_GOOGLE_PLAY_SERVICE_ACCOUNT_FILE","").strip()
    if not filename: raise PlayError("google_play_not_configured")
    try:
        path=Path(filename)
        stamp=(str(path.resolve()),path.stat().st_mtime_ns)
        if _credentials is None or _credential_file!=stamp:
            if path.stat().st_size>65536: raise ValueError()
            info=json.loads(path.read_text(encoding="utf-8"))
            if (info.get("type")!="service_account" or info.get("token_uri")!=OAUTH
                    or not str(info.get("client_email","")).endswith(".iam.gserviceaccount.com")
                    or info.get("universe_domain","googleapis.com")!="googleapis.com"):
                raise ValueError()
            _credentials=service_account.Credentials.from_service_account_info(info,scopes=["https://www.googleapis.com/auth/androidpublisher"])
            _credential_file=stamp
        return _credentials
    except (OSError,ValueError,TypeError,KeyError):
        raise PlayError("google_play_invalid_credentials") from None


def configured_context(user_id):
    package,products,plans=catalog()
    with _auth_lock: credentials()
    encryption_key()
    return {"packageName":package,"productIds":products,"basePlanIds":plans,"obfuscatedAccountId":binding(user_id)}


def request(method,path,*,body=None):
    url=PUBLISHER+path
    headers={}
    try:
        with _auth_lock: credentials().before_request(Transport(),method,url,headers)
        response=httpx.request(method,url,headers=headers,json=(body or {}) if method=="POST" else None,timeout=10,follow_redirects=False)
    except PlayError: raise
    except Exception:
        raise PlayError("google_play_provider_unavailable") from None
    if response.status_code not in {200,204}:
        logger.warning("google_play provider status=%s code=provider_rejected",response.status_code)
        if response.status_code in {400,404,410}: raise PlayError("google_play_invalid_purchase",422)
        raise PlayError("google_play_provider_unavailable",503)
    if len(response.content)>65536: raise PlayError("google_play_invalid_response",502)
    if method=="POST": return None
    try:
        value=response.json()
        if not isinstance(value,dict): raise ValueError()
        return value
    except ValueError:
        raise PlayError("google_play_invalid_response",502) from None


def get_purchase(package,token):
    token_hash(token)
    return request("GET",quote(package,safe="")+"/purchases/subscriptionsv2/tokens/"+quote(token,safe=""))


def acknowledge(package,product,token,*,obfuscated_account_id=None):
    body={}
    if obfuscated_account_id is not None:
        if not re.fullmatch(r"[a-f0-9]{64}",obfuscated_account_id):raise PlayError("google_play_purchase_not_owned",409)
        body={"externalAccountIds":{"obfuscatedAccountId":obfuscated_account_id}}
    return request("POST",quote(package,safe="")+"/purchases/subscriptions/"+quote(product,safe="")+"/tokens/"+quote(token,safe="")+":acknowledge",body=body)


def verify_push(authorization):
    audience=os.getenv("SCISONOMICS_GOOGLE_PLAY_RTDN_AUDIENCE","").strip()
    email=os.getenv("SCISONOMICS_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL","").strip()
    subscription=os.getenv("SCISONOMICS_GOOGLE_PLAY_RTDN_SUBSCRIPTION","").strip()
    if not audience.startswith("https://") or not email.endswith(".iam.gserviceaccount.com") or not subscription:
        raise PlayError("google_play_rtdn_not_configured")
    if not authorization or not authorization.lower().startswith("bearer "): raise PlayError("google_play_rtdn_unauthorized",401)
    try:
        claims=id_token.verify_oauth2_token(authorization.split(" ",1)[1].strip(),Transport(),audience=audience)
        if claims.get("email")!=email or claims.get("email_verified") is not True: raise ValueError()
    except PlayError: raise
    except Exception: raise PlayError("google_play_rtdn_unauthorized",401) from None
    return subscription

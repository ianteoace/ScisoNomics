"""Local staging-only harness. No application changes, bypass or native key access."""
import argparse
import base64
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import getpass
import hashlib
import json
import logging
import os
from pathlib import Path
import random
import sys
import threading
import time
from uuid import UUID, uuid4

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from modern_app.cloud_backend.app.device_verification import (
    DeviceProofFields, DeviceProofPurpose, base64url_decode, base64url_encode,
    build_device_proof_message,
)
from secret_store import external, read, save

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
BASE = "https://marvelous-intuition-staging.up.railway.app"
SUPABASE = "https://ktfrqbghsrfmfkzzapkh.supabase.co"
PREFIX = "SCISONOMICS_LOADTEST_"
PROFILE = (("warmup", 5, 20), ("10vus", 10, 30), ("25vus", 25, 60), ("50vus", 50, 60), ("rampdown", 50, 20))
READS = {"sync_health": "/sync/health", "sync_pull": "/sync/pull",
         "subscription": "/billing/subscription", "account": "/auth/me"}
PROVISION = {"/auth/supabase/bootstrap", "/auth/devices/login",
             "/auth/devices/enrollment/challenge", "/auth/devices/enrollment/complete",
             "/auth/devices/authentication/complete", "/auth/devices/refresh/challenge",
             "/auth/devices/refresh/complete"}
TYPE = "scisonomics-staging-loadtest-v1"


class SafeError(Exception):
    """Only static harness error codes; no provider body, URL, headers or secrets."""


def require(condition, code):
    if not condition:
        raise SafeError(code)


def claims(token):
    try:
        return json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)))
    except Exception:
        raise SafeError("invalid_token_format") from None


def load_config(path=None):
    values = read(path) if path else {}
    require(not values or values.get("kind") == TYPE + ":config", "wrong_config_file")
    config = {key: os.getenv(PREFIX + key, values.get(key, "")) for key in
              ("BASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "QA_EMAIL", "QA_PASSWORD", "QA_CONFIRMED", "STATE_DIR")}
    require(config["BASE_URL"].rstrip("/") == BASE and config["SUPABASE_URL"].rstrip("/") == SUPABASE, "staging_target_required")
    require(os.getenv("NODE_TLS_REJECT_UNAUTHORIZED") != "0", "tls_verification_required")
    require(config["QA_CONFIRMED"] == "1", "dedicated_qa_confirmation_required")
    require(config["QA_EMAIL"] and "@" in config["QA_EMAIL"] and config["QA_PASSWORD"], "qa_credentials_missing")
    key = config["SUPABASE_PUBLISHABLE_KEY"]
    require(key.startswith("sb_publishable_") or (key.count(".") == 2 and claims(key).get("role") == "anon"), "publishable_key_required")
    config["QA_EMAIL"] = config["QA_EMAIL"].strip().lower()
    directory = external(config["STATE_DIR"])
    require(directory.name.lower().startswith("scisonomicsloadtest"), "dedicated_state_directory_required")
    config["STATE_DIR"] = directory
    return config


def http_client():
    return httpx.Client(timeout=httpx.Timeout(10), follow_redirects=False, trust_env=False,
                        limits=httpx.Limits(max_connections=50, max_keepalive_connections=50))


def api(client, path, token, body=None, *, supabase=False, key=None, params=None):
    allowed = {"/auth/v1/token", "/auth/v1/user"} if supabase else set(READS.values()) | PROVISION | {"/auth/devices/context"}
    require(path in allowed, "endpoint_not_allowed")
    require(body is None or path in ({"/auth/v1/token"} if supabase else PROVISION), "load_write_not_allowed")
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"} if token else {"Accept": "application/json"}
    if supabase:
        headers["apikey"] = key
    try:
        response = client.request("POST" if body is not None else "GET", (SUPABASE if supabase else BASE) + path,
                                  headers=headers, json=body, params=params)
    except httpx.HTTPError:
        raise SafeError("setup_network_or_timeout") from None
    require(response.status_code == 200, "setup_http_" + str(response.status_code))
    require(len(response.content) <= 2 * 1024 * 1024, "response_too_large")
    try:
        return response.json()
    except ValueError:
        raise SafeError("invalid_json_response") from None


def check_provider(client, cfg, session):
    decoded = claims(session["access_token"])
    require(decoded.get("iss") == SUPABASE + "/auth/v1" and decoded.get("role") == "authenticated", "wrong_supabase_identity")
    user = api(client, "/auth/v1/user", session["access_token"], supabase=True, key=cfg["SUPABASE_PUBLISHABLE_KEY"])
    require(user.get("email", "").strip().lower() == cfg["QA_EMAIL"] and user.get("email_confirmed_at"), "confirmed_qa_identity_required")
    require(user.get("id") == decoded.get("sub"), "provider_identity_mismatch")


def identity(cfg):
    path = cfg["STATE_DIR"] / "identity.dpapi"
    tag = hashlib.sha256((BASE + "\n" + SUPABASE + "\n" + cfg["QA_EMAIL"]).encode()).hexdigest()
    if path.exists():
        value = read(path)
        require(value.get("kind") == TYPE + ":identity" and value.get("qa_tag") == tag, "wrong_load_device_file")
    else:
        value = {"kind": TYPE + ":identity", "qa_tag": tag, "device_id": str(uuid4()),
                 "seed": base64url_encode(Ed25519PrivateKey.generate().private_bytes_raw())}
        save(path, value)
    uid = UUID(value["device_id"])
    require(str(uid) == value["device_id"] and uid.version == 4, "invalid_load_device_id")
    private = Ed25519PrivateKey.from_private_bytes(base64url_decode(value["seed"], expected_length=32))
    require(private.private_bytes_raw() != bytes(range(32)), "public_test_seed_not_allowed")
    public = private.public_key().public_bytes_raw()
    return private, {"formatVersion": 1, "deviceId": str(uid), "publicKey": base64url_encode(public),
                     "publicKeyHash": base64url_encode(hashlib.sha256(public).digest())}, tag


def proof(private, public, binding, challenge, purpose):
    require(isinstance(challenge["issuedAt"], int) and isinstance(challenge["expiresAt"], int), "invalid_challenge")
    require(challenge["issuedAt"] <= time.time() + 60 and challenge["expiresAt"] > time.time(), "expired_challenge")
    fields = DeviceProofFields(DeviceProofPurpose(purpose), base64url_decode(binding, expected_length=32),
                              UUID(public["deviceId"]).bytes, base64url_decode(public["publicKeyHash"], expected_length=32),
                              UUID(challenge["challengeId"]).bytes, base64url_decode(challenge["nonce"], expected_length=32),
                              challenge["issuedAt"], challenge["expiresAt"],
                              UUID(challenge["familyId"]).bytes if challenge.get("familyId") else None,
                              UUID(challenge["targetDeviceId"]).bytes if challenge.get("targetDeviceId") else None,
                              base64url_decode(challenge["requestHash"], expected_length=32) if challenge.get("requestHash") else None)
    return {**public, "signature": base64url_encode(private.sign(build_device_proof_message(fields)))}


def validate_grant(grant, owner, binding, public):
    require(grant.get("user", {}).get("id") == owner and grant.get("accountBinding") == binding
            and grant.get("deviceId") == public["deviceId"], "grant_binding_mismatch")
    decoded = claims(grant["access_token"])
    require(decoded.get("type") == "access" and decoded.get("device_authorized") is True
            and decoded.get("sub") == owner and decoded.get("device_id") == public["deviceId"]
            and decoded.get("family_id") == grant.get("familyId"), "invalid_device_grant")
    require(UUID(grant["familyId"]).int != 0, "invalid_grant_family")
    return grant


def setup(cfg):
    private, public, tag = identity(cfg)
    with http_client() as client:
        provider = api(client, "/auth/v1/token", "", {"email": cfg["QA_EMAIL"], "password": cfg["QA_PASSWORD"]},
                       supabase=True, key=cfg["SUPABASE_PUBLISHABLE_KEY"], params={"grant_type": "password"})
        check_provider(client, cfg, provider)
        user = api(client, "/auth/supabase/bootstrap", provider["access_token"], {})
        require(user.get("email", "").strip().lower() == cfg["QA_EMAIL"], "internal_qa_identity_mismatch")
        context = api(client, "/auth/devices/context", provider["access_token"])
        require(context.get("mode") == "enforce" and context.get("userId") == user["id"], "device_enforcement_required")
        binding = context["accountBinding"]
        result = api(client, "/auth/devices/login", provider["access_token"],
                     {"identity": public, "platform": "windows", "name": "ScisoNomics Load Test QA"})
        if result["status"] == "trusted":
            challenge = result["challenge"]
            grant = api(client, "/auth/devices/authentication/complete", provider["access_token"],
                        {"challenge": challenge, "proof": proof(private, public, binding, challenge, 2)})
        else:
            require(result["status"] == "pending_verification", "unexpected_device_status")
            print("El dispositivo de carga requiere OTP. Ingresalo sólo en esta terminal, nunca en el chat.")
            code = os.getenv(PREFIX + "OTP") or getpass.getpass("Código de enrollment: ")
            require(len(code) == 6 and code.isascii() and code.isdigit(), "invalid_otp_format")
            continuation = {key: result[key] for key in ("verificationId", "verificationToken")}
            challenge = api(client, "/auth/devices/enrollment/challenge", provider["access_token"], continuation)
            grant = api(client, "/auth/devices/enrollment/complete", provider["access_token"],
                        {**continuation, "code": code, "challenge": challenge, "proof": proof(private, public, binding, challenge, 1)})
        validate_grant(grant, user["id"], binding, public)
        save(cfg["STATE_DIR"] / "session.dpapi", {"kind": TYPE + ":session", "qa_tag": tag,
             "owner": user["id"], "binding": binding, "provider": {k: provider[k] for k in ("access_token", "refresh_token")}, "grant": grant})
    print("Dispositivo QA autorizado. Clave y sesión propias protegidas con DPAPI fuera del repo.")


def prepared(cfg):
    require((cfg["STATE_DIR"] / "identity.dpapi").exists() and (cfg["STATE_DIR"] / "session.dpapi").exists(), "setup_required_before_smoke_or_load")
    private, public, tag = identity(cfg)
    state = read(cfg["STATE_DIR"] / "session.dpapi")
    require(state.get("kind") == TYPE + ":session" and state.get("qa_tag") == tag, "wrong_session_file")
    with http_client() as client:
        provider = state["provider"]
        if claims(provider["access_token"]).get("exp", 0) <= time.time() + 60:
            fresh = api(client, "/auth/v1/token", "", {"refresh_token": provider["refresh_token"]},
                        supabase=True, key=cfg["SUPABASE_PUBLISHABLE_KEY"], params={"grant_type": "refresh_token"})
            state["provider"] = provider = {k: fresh[k] for k in ("access_token", "refresh_token")}
            save(cfg["STATE_DIR"] / "session.dpapi", state)
        check_provider(client, cfg, provider)
        context = api(client, "/auth/devices/context", provider["access_token"])
        require(context.get("mode") == "enforce" and context.get("userId") == state["owner"]
                and context.get("accountBinding") == state["binding"], "session_context_mismatch")
        grant = validate_grant(state["grant"], state["owner"], state["binding"], public)
        if claims(grant["access_token"]).get("exp", 0) <= time.time() + 360:
            challenge = api(client, "/auth/devices/refresh/challenge", provider["access_token"],
                            {"deviceId": public["deviceId"], "familyId": grant["familyId"]})
            require(challenge.get("familyId") == grant["familyId"], "refresh_family_mismatch")
            grant = api(client, "/auth/devices/refresh/complete", provider["access_token"],
                        {"challenge": challenge, "proof": proof(private, public, state["binding"], challenge, 3)})
            state["grant"] = validate_grant(grant, state["owner"], state["binding"], public)
            save(cfg["STATE_DIR"] / "session.dpapi", state)
        require(claims(grant["access_token"]).get("exp", 0) > time.time() + 360, "grant_ttl_too_short_for_profile")
    return state


def percentile(values, q):
    if not values:
        return 0
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    low = int(index)
    return ordered[low] + (ordered[min(low + 1, len(ordered) - 1)] - ordered[low]) * (index - low)


def summarize(samples, duration):
    latencies = [s[2] for s in samples]
    counts = Counter(str(s[1]) for s in samples)
    total = len(samples)
    failures = sum(s[1] != 200 for s in samples)
    return {"requests": total, "rps": round(total / duration, 3) if duration else 0,
            "statuses": dict(counts), "errors_by_status": {k: v for k, v in counts.items() if k != "200"},
            "error_rate": failures / total if total else 0,
            "timeouts": sum(s[3] == "timeout" for s in samples),
            "transport_errors": sum(s[3] == "transport" for s in samples),
            **{label: sum(predicate(s[1]) for s in samples) / total if total else 0 for label, predicate in
               (("rate_401", lambda n: n == 401), ("rate_403", lambda n: n == 403),
                ("rate_429", lambda n: n == 429), ("rate_5xx", lambda n: 500 <= n < 600))},
            **{label: round(percentile(latencies, q), 3) for label, q in (("p50_ms", .5), ("p90_ms", .9), ("p95_ms", .95), ("p99_ms", .99))},
            "max_ms": round(max(latencies, default=0), 3), "avg_ms": round(sum(latencies) / total, 3) if total else 0}


def thresholds(summary):
    return summary["requests"] > 0 and summary["error_rate"] < .01 and summary["p95_ms"] < 1000 and summary["rate_5xx"] == 0 and summary["timeouts"] == 0


class Metrics:
    def __init__(self):
        self.lock = threading.RLock()
        self.samples = []
        self.recent = deque()
        self.inflight = 0
        self.peak = 0
        self.slow_since = None
        self.observed_vus = set()
        self.stage_vus = {}
        self.stage_peak = {}

    def begin(self):
        with self.lock:
            self.inflight += 1
            self.peak = max(self.peak, self.inflight)

    def end(self, endpoint, status, latency, error, stage):
        with self.lock:
            item = (endpoint, status, latency, error, stage, time.monotonic())
            self.samples.append(item)
            self.recent.append(item)
            self.inflight -= 1

    def unsafe(self, tick):
        with self.lock:
            while self.recent and self.recent[0][5] < tick - 10:
                self.recent.popleft()
            if not self.recent:
                self.slow_since = None
                return None
            summary = summarize(list(self.recent), 10)
            if summary["rate_5xx"] > .02:
                return "5xx_over_2_percent"
            if summary["timeouts"] / summary["requests"] > .01:
                return "timeouts_over_1_percent"
            slow = len(self.recent) >= 10 and summary["p95_ms"] > 3000
            self.slow_since = (self.slow_since if self.slow_since is not None else tick) if slow else None
            return "p95_over_3s_sustained_10s" if self.slow_since is not None and tick - self.slow_since >= 10 else None


def run_load(state, requester=None, profile=PROFILE, think=1.0):
    require(profile == PROFILE or requester is not None, "custom_live_profile_not_allowed")
    require(all(0 <= vus <= 50 for _, vus, _ in profile), "max_50_vus")
    metrics = Metrics()
    stop = threading.Event()
    control = {"target": 0, "stage": "", "reason": None}
    stage_results = []
    started = time.monotonic()
    token = state["grant"]["access_token"]
    with http_client() as client:
        def request(endpoint):
            try:
                deadline = time.monotonic() + 10
                with client.stream("GET", BASE + READS[endpoint],
                                   headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
                                   params={"since": state["cursor"]} if endpoint == "sync_pull" else None) as response:
                    size = 0
                    if time.monotonic() > deadline:
                        raise httpx.ReadTimeout("load_deadline")
                    for chunk in response.iter_raw():
                        size += len(chunk)
                        if size > 2 * 1024 * 1024:
                            return 0, "response_limit"
                        if time.monotonic() > deadline:
                            raise httpx.ReadTimeout("load_deadline")
                    return response.status_code, None
            except httpx.TimeoutException:
                return 0, "timeout"
            except httpx.HTTPError:
                return 0, "transport"
        perform = requester or request
        def worker(index):
            rng = random.Random(index)
            while not stop.is_set():
                with metrics.lock:
                    eligible = index < control["target"] and not stop.is_set()
                    if eligible:
                        stage = control["stage"]
                        metrics.begin()
                        metrics.observed_vus.add(index)
                        metrics.stage_vus.setdefault(stage, set()).add(index)
                        metrics.stage_peak[stage] = max(metrics.stage_peak.get(stage, 0), metrics.inflight)
                if not eligible:
                    stop.wait(.05)
                    continue
                endpoint = rng.choices(tuple(READS), (.5, .3, .1, .1))[0]
                began = time.monotonic()
                try:
                    status, error = perform(endpoint)
                except Exception:
                    status, error = 0, "transport"
                metrics.end(endpoint, status, (time.monotonic() - began) * 1000, error, stage)
                if status in {401, 403, 429} or error in {"response_limit", "transport"}:
                    with metrics.lock:
                        control["reason"] = control["reason"] or "auth_or_throttle_or_transport_abort"
                    stop.set()
                stop.wait(think)
        with ThreadPoolExecutor(max_workers=50) as executor:
            futures = [executor.submit(worker, n) for n in range(50)]
            try:
                for label, target, duration in profile:
                    with metrics.lock:
                        control.update(stage=label, target=target)
                    began = time.monotonic()
                    while not stop.is_set() and time.monotonic() - began < duration:
                        elapsed = time.monotonic() - began
                        if label == "rampdown":
                            with metrics.lock:
                                control["target"] = max(0, int(target * (1 - elapsed / duration)))
                        reason = metrics.unsafe(time.monotonic())
                        if reason:
                            control["reason"] = reason
                            stop.set()
                        stop.wait(.2)
                    with metrics.lock:
                        control["target"] = 0
                    while metrics.inflight and not stop.is_set():
                        reason = metrics.unsafe(time.monotonic())
                        if reason:
                            control["reason"] = reason
                            stop.set()
                        stop.wait(.05)
                    samples = [s for s in metrics.samples if s[4] == label]
                    result = {"stage": label, "vus": target, "elapsed_s": round(time.monotonic() - began, 3),
                              "observed_vus": len(metrics.stage_vus.get(label, set())),
                              "peak_concurrent_requests": metrics.stage_peak.get(label, 0),
                              **summarize(samples, max(.001, time.monotonic() - began))}
                    stage_results.append(result)
                    print(f"{label}: VUs<= {target}; requests={result['requests']}; p95={result['p95_ms']:.1f}ms; errores={result['error_rate']:.2%}")
                    if not thresholds(result) and label != "rampdown":
                        control["reason"] = control["reason"] or "stage_threshold_failure"
                        stop.set()
                    if stop.is_set():
                        break
            except KeyboardInterrupt:
                control["reason"] = "operator_interrupt"
            finally:
                stop.set()
                for future in futures:
                    future.result()
    duration = time.monotonic() - started
    # In-flight requests drain after abort; include them in stage totals as well.
    if stage_results and control["reason"]:
        stage_results[-1]["elapsed_s"] = round(max(stage_results[-1]["elapsed_s"], duration - sum(s["elapsed_s"] for s in stage_results[:-1])), 3)
    for result in stage_results:
        result.update(summarize([s for s in metrics.samples if s[4] == result["stage"]], max(.001, result["elapsed_s"])))
    summary = summarize(metrics.samples, duration)
    return {"environment": "staging", "elapsed_s": round(duration, 3), "max_vus_allowed": 50,
            "max_vus_reached": len(metrics.observed_vus),
            "peak_concurrent_requests": metrics.peak, "abort_reason": control["reason"],
            "thresholds_passed": thresholds(summary) and control["reason"] is None,
            "summary": summary, "stages": stage_results,
            "endpoints": {name: {"path": path, **summarize([s for s in metrics.samples if s[0] == name], duration)} for name, path in READS.items()}}


def smoke_and_cursor(cfg, state, load):
    with http_client() as client:
        begin = time.perf_counter()
        response = api(client, READS["sync_health"], state["grant"]["access_token"])
        require(response.get("ok") is True and response.get("sync_ready") is True and response.get("user_id") == state["owner"], "smoke_identity_or_readiness_mismatch")
        print(f"Smoke: GET /sync/health status=200; latency_ms={(time.perf_counter()-begin)*1000:.1f}")
        if load:
            pulled = api(client, READS["sync_pull"], state["grant"]["access_token"])
            cursor = pulled.get("cursor")
            require(isinstance(cursor, str) and len(cursor) <= 100 and datetime.fromisoformat(cursor.replace("Z", "+00:00")).tzinfo, "invalid_sync_cursor")
            state["cursor"] = cursor


def configure(path):
    require(not external(path).exists(), "config_already_exists")
    values = {"kind": TYPE + ":config", "BASE_URL": BASE, "SUPABASE_URL": SUPABASE,
              "QA_EMAIL": getpass.getpass("Email QA dedicado: ").strip(),
              "QA_PASSWORD": getpass.getpass("Contraseña QA: "),
              "SUPABASE_PUBLISHABLE_KEY": getpass.getpass("Publishable key de Supabase staging: "),
              "STATE_DIR": str(external(path).parent), "QA_CONFIRMED": "1"}
    require(input("Confirmá que es una cuenta QA exclusiva de staging escribiendo QA: ") == "QA", "dedicated_qa_confirmation_required")
    save(path, values)
    print("Configuración protegida por DPAPI fuera del repo. No se imprimieron credenciales.")


def print_report(report):
    summary = report["summary"]
    print(f"Total: {summary['requests']} requests; {summary['rps']:.2f} req/s; duración={report['elapsed_s']:.1f}s")
    print(f"VUs observados={report['max_vus_reached']}/50; pico de requests concurrentes={report['peak_concurrent_requests']}")
    print(f"Latencias ms: p50={summary['p50_ms']:.1f}; p90={summary['p90_ms']:.1f}; p95={summary['p95_ms']:.1f}; p99={summary['p99_ms']:.1f}; max={summary['max_ms']:.1f}")
    print(f"Errores={summary['error_rate']:.2%}; timeouts={summary['timeouts']}; transporte={summary['transport_errors']}; statuses={summary['statuses']}")
    print("Tasas: " + "; ".join(f"{key[5:]}={summary[key]:.2%}" for key in ('rate_401', 'rate_403', 'rate_429', 'rate_5xx')))
    for row in report["endpoints"].values():
        print(f"{row['path']}: n={row['requests']}; rps={row['rps']:.2f}; p50={row['p50_ms']:.1f}; p90={row['p90_ms']:.1f}; p95={row['p95_ms']:.1f}; p99={row['p99_ms']:.1f}; max={row['max_ms']:.1f}; errores={row['error_rate']:.2%}")
    print("Thresholds: " + ("PASS" if report["thresholds_passed"] else "FAIL"))
    if report['abort_reason']:
        print("Aborto: " + report['abort_reason'])


def main():
    parser = argparse.ArgumentParser(description="Staging-only authenticated loadtest; own QA device; no native key access.")
    parser.add_argument("command", choices=("configure", "setup", "smoke", "run"))
    parser.add_argument("--config", default=os.getenv(PREFIX + "CONFIG_FILE"))
    parser.add_argument("--json-out")
    args = parser.parse_args()
    if args.json_out:
        require(not external(args.json_out).exists(), "report_path_already_exists")
    if args.command == "configure":
        require(args.config, "external_config_path_required")
        configure(args.config)
        return 0
    cfg = load_config(args.config)
    if args.command == "setup":
        setup(cfg)
        return 0
    state = prepared(cfg)
    smoke_and_cursor(cfg, state, args.command == "run")
    if args.command == "smoke":
        return 0
    report = run_load(state)
    print_report(report)
    if args.json_out:
        path = external(args.json_out)
        with path.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2)
    return 0 if report["thresholds_passed"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SafeError as exc:
        print("Error seguro: " + str(exc), file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        print("Interrumpido; no se inicia más carga.", file=sys.stderr)
        sys.exit(2)
    except Exception:
        print("Error seguro: harness_configuration_or_storage_error", file=sys.stderr)
        sys.exit(2)

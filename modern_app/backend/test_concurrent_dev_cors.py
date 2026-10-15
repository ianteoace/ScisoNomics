"""Exercise the configured CORS boundary without starting finance DB/server."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

PROGRAM = r'''
import asyncio, json
from modern_app.backend.app.main import app, CORSMiddleware
options = next(m.kwargs for m in app.user_middleware if m.cls is CORSMiddleware)
async def downstream(scope, receive, send):
    await send({'type':'http.response.start','status':200,'headers':[]})
    await send({'type':'http.response.body','body':b'OK'})
middleware = CORSMiddleware(downstream, **options)
async def check(origin):
    messages=[]
    async def receive(): return {'type':'http.request','body':b''}
    async def send(message): messages.append(message)
    await middleware({'type':'http','method':'OPTIONS','path':'/probe','headers':[(b'origin',origin.encode()),(b'access-control-request-method',b'POST'),(b'access-control-request-headers',b'content-type,x-scisonomics-local-token')]}, receive, send)
    response=messages[0]
    headers=dict(response['headers'])
    return {'status':response['status'],'origin':headers.get(b'access-control-allow-origin',b'').decode()}
print(json.dumps({origin:asyncio.run(check(origin)) for origin in ['http://localhost:3000','http://localhost:3001','http://127.0.0.1:3001','https://evil.example']}))
'''


class ConcurrentDevCorsTests(unittest.TestCase):
    def check(self, enabled):
        with tempfile.TemporaryDirectory(prefix="sciso-cors-") as root:
            env = dict(os.environ, LOCALAPPDATA=root, SCISONOMICS_LOCAL_TOKEN="fixture-local-token")
            env["SCISONOMICS_DESKTOP_CONCURRENT_DEV"] = "1" if enabled else "0"
            result = subprocess.run([sys.executable, "-c", PROGRAM], env=env, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)

    def test_normal_backend_retains_original_origins(self):
        result = self.check(False)
        self.assertEqual(result["http://localhost:3000"]["status"], 200)
        self.assertEqual(result["http://localhost:3001"]["status"], 400)
        self.assertEqual(result["https://evil.example"]["status"], 400)

    def test_opt_in_allows_only_exact_concurrent_origin(self):
        result = self.check(True)
        self.assertEqual(result["http://localhost:3001"], {"status": 200, "origin": "http://localhost:3001"})
        self.assertEqual(result["http://localhost:3000"]["status"], 200)
        self.assertEqual(result["http://127.0.0.1:3001"]["status"], 400)
        self.assertEqual(result["https://evil.example"]["status"], 400)


if __name__ == "__main__":
    unittest.main()

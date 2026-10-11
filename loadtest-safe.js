import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '60s', target: 50 },
    { duration: '60s', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

const BASE_URL = 'https://marvelous-intuition-staging.up.railway.app';

export default function () {
  const res = http.get(`${BASE_URL}/health`, {
    timeout: '10s',
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'response under 1s': (r) => r.timings.duration < 1000,
  });

  sleep(1);
}
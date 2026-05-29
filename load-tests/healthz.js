import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, defaultThresholds } from './lib.js';

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<500'],
  },
};

export default function healthz() {
  const res = http.get(`${baseUrl()}/healthz`, { tags: { name: 'healthz' } });
  check(res, {
    'healthz status 200': (r) => r.status === 200,
    'healthz body ok': (r) => r.json('status') === 'ok',
  });
  sleep(0.5);
}

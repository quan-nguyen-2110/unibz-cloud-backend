import http from 'k6/http';
import { check, sleep } from 'k6';
import { defaultThresholds, rampStages, setupAuth } from './lib.js';

export const options = {
  stages: rampStages,
  thresholds: defaultThresholds,
};

export function setup() {
  return setupAuth();
}

export default function feed(data) {
  // First page.
  const first = http.get(`${data.base}/plans/feed?limit=10&offset=0`, {
    headers: data.headers,
    tags: { name: 'plans_feed' },
  });
  const ok = check(first, {
    'feed status 200': (r) => r.status === 200,
    'feed has plans array': (r) => Array.isArray(r.json('plans')),
    'feed has pagination meta': (r) =>
      typeof r.json('hasMore') === 'boolean' &&
      typeof r.json('offset') === 'number',
  });

  // Follow pagination when there's a next page.
  if (ok && first.status === 200 && first.json('hasMore')) {
    const nextOffset = first.json('nextOffset') || 10;
    const next = http.get(
      `${data.base}/plans/feed?limit=10&offset=${nextOffset}`,
      { headers: data.headers, tags: { name: 'plans_feed_page2' } }
    );
    check(next, {
      'feed page 2 status 200': (r) => r.status === 200,
    });
  }

  sleep(1);
}

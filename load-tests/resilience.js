import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  baseUrl,
  resilienceStages,
  resilienceThresholds,
  setupAuth,
} from './lib.js';

/**
 * Sustained mixed read load for ALB/ECS failover measurement.
 * Pair with scripts/run-resilience-experiment.ps1 which kills a task ~90 s in.
 */
export const options = {
  stages: resilienceStages,
  thresholds: resilienceThresholds,
};

export function setup() {
  return setupAuth();
}

export default function resilience(data) {
  const feed = http.get(`${data.base}/plans/feed?limit=10&offset=0`, {
    headers: data.headers,
    tags: { name: 'plans_feed' },
  });
  check(feed, {
    'feed status 200': (r) => r.status === 200,
  });

  const notes = http.get(`${data.base}/notifications?limit=20`, {
    headers: data.headers,
    tags: { name: 'notifications_list' },
  });
  check(notes, {
    'notifications status 200': (r) => r.status === 200,
  });

  const health = http.get(`${baseUrl()}/healthz`, {
    tags: { name: 'healthz' },
  });
  check(health, {
    'healthz status 200': (r) => r.status === 200,
  });

  sleep(0.5);
}

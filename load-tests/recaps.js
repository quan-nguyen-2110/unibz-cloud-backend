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

export default function recaps(data) {
  const res = http.get(`${data.base}/plans/recaps`, {
    headers: data.headers,
    tags: { name: 'plans_recaps' },
  });
  const ok = check(res, {
    'recaps status 200': (r) => r.status === 200,
    'recaps has plans array': (r) => Array.isArray(r.json('plans')),
  });

  // Toggle profile-share on a recap plan occasionally.
  if (ok && res.status === 200) {
    const plans = res.json('plans') || [];
    if (plans.length > 0 && Math.random() < 0.3) {
      const plan = plans[Math.floor(Math.random() * plans.length)];
      const share = http.patch(
        `${data.base}/plans/${plan.id}/profile-share`,
        JSON.stringify({ sharedToProfile: !plan.sharedToProfile }),
        { headers: data.headers, tags: { name: 'plans_profile_share' } }
      );
      check(share, {
        'profile-share status 200': (r) => r.status === 200,
      });
    }
  }

  sleep(1);
}

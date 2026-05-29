import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  defaultThresholds,
  planDraft,
  rampStages,
  setupAuth,
  vibeLabelsBody,
} from './lib.js';

export const options = {
  stages: rampStages,
  thresholds: defaultThresholds,
};

export function setup() {
  return setupAuth();
}

function readFeed(data) {
  const feed = http.get(`${data.base}/plans/feed?limit=20&offset=0`, {
    headers: data.headers,
    tags: { name: 'plans_feed' },
  });
  check(feed, {
    'feed status 200': (r) => r.status === 200,
  });
  return feed;
}

function createAndEngage(data) {
  const create = http.post(
    `${data.base}/plans`,
    JSON.stringify(planDraft(`${__VU}-${__ITER}`)),
    { headers: data.headers, tags: { name: 'plans_create' } }
  );
  check(create, {
    'create status 201': (r) => r.status === 201,
  });
  if (create.status !== 201) return;

  const planId = create.json('plan.id');

  const tap = http.post(`${data.base}/plans/${planId}/tap-in`, null, {
    headers: data.headers,
    tags: { name: 'plans_tap_in' },
  });
  check(tap, {
    'tap-in status 200': (r) => r.status === 200,
  });

  // Host manually locks the plan ~30% of the time.
  if (Math.random() < 0.3) {
    const lock = http.post(`${data.base}/plans/${planId}/lock`, null, {
      headers: data.headers,
      tags: { name: 'plans_lock' },
    });
    check(lock, {
      'lock status 200': (r) => r.status === 200,
    });
  }
}

function tapInExisting(data) {
  const feed = readFeed(data);
  if (feed.status !== 200) {
    sleep(1);
    return;
  }
  const plans = feed.json('plans') || [];
  if (plans.length === 0) {
    sleep(1);
    return;
  }
  const plan = plans[Math.floor(Math.random() * plans.length)];
  const tap = http.post(`${data.base}/plans/${plan.id}/tap-in`, null, {
    headers: data.headers,
    tags: { name: 'plans_tap_in_existing' },
  });
  check(tap, {
    'tap-in existing ok': (r) =>
      r.status === 200 || r.status === 409,
  });
}

function checkNotifications(data) {
  const list = http.get(`${data.base}/notifications?limit=50`, {
    headers: data.headers,
    tags: { name: 'notifications_list' },
  });
  check(list, {
    'notifications status 200': (r) => r.status === 200,
    'notifications has count': (r) => typeof r.json('unreadCount') === 'number',
  });

  // Occasionally clear the inbox.
  if (list.status === 200 && (list.json('unreadCount') || 0) > 0 && Math.random() < 0.5) {
    const readAll = http.post(`${data.base}/notifications/read-all`, null, {
      headers: data.headers,
      tags: { name: 'notifications_read_all' },
    });
    check(readAll, {
      'read-all status 200': (r) => r.status === 200,
    });
  }
}

function browseRecapsAndVibes(data) {
  const recaps = http.get(`${data.base}/plans/recaps`, {
    headers: data.headers,
    tags: { name: 'plans_recaps' },
  });
  check(recaps, {
    'recaps status 200': (r) => r.status === 200,
  });

  const labels = http.post(
    `${data.base}/plans/vibe-labels`,
    JSON.stringify(vibeLabelsBody()),
    { headers: data.headers, tags: { name: 'plans_vibe_labels' } }
  );
  check(labels, {
    'vibe-labels status 200': (r) => r.status === 200,
  });
}

export default function mixedScenario(data) {
  const roll = Math.random();

  if (roll < 0.45) {
    readFeed(data);
  } else if (roll < 0.65) {
    createAndEngage(data);
  } else if (roll < 0.8) {
    tapInExisting(data);
  } else if (roll < 0.93) {
    checkNotifications(data);
  } else {
    browseRecapsAndVibes(data);
  }

  sleep(1);
}

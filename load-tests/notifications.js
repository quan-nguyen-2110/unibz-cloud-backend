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

export default function notifications(data) {
  const list = http.get(`${data.base}/notifications?limit=50`, {
    headers: data.headers,
    tags: { name: 'notifications_list' },
  });
  check(list, {
    'list status 200': (r) => r.status === 200,
    'list has notifications array': (r) =>
      Array.isArray(r.json('notifications')),
    'list has unreadCount': (r) => typeof r.json('unreadCount') === 'number',
  });

  // Unread-only filter.
  const unread = http.get(
    `${data.base}/notifications?unreadOnly=true&limit=50`,
    { headers: data.headers, tags: { name: 'notifications_unread' } }
  );
  check(unread, {
    'unread status 200': (r) => r.status === 200,
  });

  // Mark one as read when present.
  if (list.status === 200) {
    const items = list.json('notifications') || [];
    const target = items.find((n) => !n.read);
    if (target) {
      const read = http.patch(
        `${data.base}/notifications/${target.id}/read`,
        null,
        { headers: data.headers, tags: { name: 'notifications_read' } }
      );
      check(read, {
        'mark read status 200': (r) => r.status === 200,
      });
    }
  }

  sleep(1);
}

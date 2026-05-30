import http from 'k6/http';

export const DEFAULT_BASE_URL =
  'http://squadup-alb-363579702.us-east-1.elb.amazonaws.com';

export function baseUrl() {
  return (__ENV.BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function authHeaders(token, devUserId) {
  if (devUserId) {
    return {
      'Content-Type': 'application/json',
      'X-Dev-User-Id': devUserId,
    };
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function login(base, email, password) {
  const res = http.post(
    `${base}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth_login' } }
  );
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${res.body}`);
  }
  const token = res.json('accessToken');
  if (!token) {
    throw new Error('login response missing accessToken');
  }
  return token;
}

export function setupAuth() {
  const base = baseUrl();
  const devUserId = __ENV.DEV_USER_ID;
  if (devUserId) {
    return { base, headers: authHeaders(null, devUserId) };
  }

  const token = __ENV.TOKEN;
  if (token) {
    return { base, headers: authHeaders(token) };
  }

  const email = __ENV.EMAIL;
  const password = __ENV.PASSWORD;
  if (email && password) {
    return { base, headers: authHeaders(login(base, email, password)) };
  }

  throw new Error(
    'Set TOKEN, or EMAIL+PASSWORD, or DEV_USER_ID (local dev auth only)'
  );
}

export function futureStartAt(minutesFromNow = 120) {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

/** Built-in vibe emojis (server returns labels without hitting Bedrock). */
export const VIBE_EMOJIS = ['🏀', '🏊', '☕', '📖', '🎮'];

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function planDraft(titleSuffix) {
  // Only send fields with real values: the API's optional string validators are
  // not nullable, so sending `null` for description/gameName/transcript -> 400.
  // durationMinutes is optional({ nullable: true }), so null is allowed there.
  const draft = {
    vibeEmoji: pickRandom(VIBE_EMOJIS),
    title: `k6 ${titleSuffix}`,
    startAt: futureStartAt(),
    durationMinutes: pickRandom([60, 90, 120, null]),
    threshold: 4,
    activities: [],
    location: 'Load test location',
    source: 'manual',
    visibility: 'public',
  };
  return draft;
}

/** Body for POST /plans/vibe-labels using built-in emojis (no Bedrock cost). */
export function vibeLabelsBody() {
  return { emojis: VIBE_EMOJIS };
}

export const defaultThresholds = {
  http_req_failed: ['rate<0.05'],
  http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  // Reads should stay fast even under load.
  'http_req_duration{name:plans_feed}': ['p(95)<1500'],
  'http_req_duration{name:notifications_list}': ['p(95)<1500'],
};

export const rampStages = [
  { duration: '30s', target: 10 },
  { duration: '1m', target: 25 },
  { duration: '1m', target: 50 },
  { duration: '30s', target: 0 },
];

/** Steady load for resilience / failover experiments (~5 min). */
export const resilienceStages = [
  { duration: '30s', target: 20 },
  { duration: '4m', target: 30 },
  { duration: '30s', target: 0 },
];

/** Relaxed thresholds — we expect a brief error spike during task kill. */
export const resilienceThresholds = {
  http_req_failed: ['rate<0.15'],
  http_req_duration: ['p(95)<5000', 'p(99)<10000'],
};

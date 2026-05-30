# Statistical analysis (p95 latency, ms)

## feed (n=5)
- mean p95: 2339.1 ms, 95% CI [1401.3, 3276.8]

## healthz (n=5)
- mean p95: 176.3 ms, 95% CI [124.7, 227.9]

## notifications (n=5)
- mean p95: 227.1 ms, 95% CI [193.9, 260.2]

## Welch t-test: feed vs notifications (p95)
- mean_a_ms: 2339.1
- mean_b_ms: 227.1
- t: 6.248
- df: 4.0
- t_crit_95: 2.776
- significant_95: True
- interpretation: reject H0 (means differ)
- **Claim supported:** feed p95 is significantly different from notifications at α=0.05.


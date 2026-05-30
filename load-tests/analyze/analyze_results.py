#!/usr/bin/env python3
"""
Analyze k6 summary-export JSON from scale-out, statistical, and resilience experiments.

Usage:
  python analyze_results.py --scale-out ../results/scale-out
  python analyze_results.py --statistical ../results/statistical
  python analyze_results.py --resilience ../results/resilience
  python analyze_results.py --all ../results
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Fargate us-east-1 on-demand (Linux x86), May 2026 list prices.
FARGATE_VCPU_HOUR = 0.04048
FARGATE_GB_HOUR = 0.004445
TASK_VCPU = 0.5
TASK_GB = 1.0


@dataclass
class RunMetrics:
    path: Path
    scenario: str
    task_count: int | None
    p95_ms: float
    p99_ms: float | None
    throughput_rps: float
    http_reqs: int
    fail_rate: float
    duration_sec: float


def _metric_value(metrics: dict, name: str, key: str) -> float | None:
    block = metrics.get(name) or {}
    # k6 --summary-export: flat keys on metric (v2) or nested "values" (older).
    values = block.get("values") or block
    key_map = {
        "p(95)": "p(95)",
        "p95": "p(95)",
        "p(99)": "p(99)",
        "p99": "p(99)",
        "rate": "rate",
        "count": "count",
    }
    lookup = key_map.get(key, key)
    if lookup in values:
        val = values[lookup]
        if val is not None and not (isinstance(val, float) and math.isnan(val)):
            return float(val)
    # http_req_failed rate is stored as "value" in k6 v2 export
    if key == "rate" and "value" in values:
        return float(values["value"])
    return None


def parse_summary(path: Path, scenario: str = "", task_count: int | None = None) -> RunMetrics:
    data = json.loads(path.read_text(encoding="utf-8"))
    metrics = data.get("metrics") or data.get("root_group", {}).get("metrics") or {}

    if not metrics and "metrics" in data.get("state", {}):
        metrics = data["state"]["metrics"]

    p95 = _metric_value(metrics, "http_req_duration", "p(95)")
    p99 = _metric_value(metrics, "http_req_duration", "p(99)")
    throughput = _metric_value(metrics, "http_reqs", "rate") or 0.0
    count = int(_metric_value(metrics, "http_reqs", "count") or 0)
    fail_rate = _metric_value(metrics, "http_req_failed", "rate") or 0.0

    duration_sec = 180.0
    if "iteration_duration" in metrics:
        dur = metrics["iteration_duration"]
        if dur.get("max"):
            duration_sec = max(duration_sec, float(dur["max"]) / 1000.0 * 2)
    # Standard ramp profile is ~3 min
    if duration_sec < 120:
        duration_sec = 180.0

    name = path.stem
    if task_count is None:
        m = re.search(r"tasks(\d+)_", name)
        if m:
            task_count = int(m.group(1))

    if not scenario:
        m = re.match(r"([a-z]+)_run", name)
        scenario = m.group(1) if m else "unknown"

    if p95 is None:
        p95 = float("nan")

    return RunMetrics(
        path=path,
        scenario=scenario,
        task_count=task_count,
        p95_ms=p95,
        p99_ms=p99,
        throughput_rps=throughput,
        http_reqs=count,
        fail_rate=fail_rate,
        duration_sec=duration_sec,
    )


def t_critical_95(df: int) -> float:
    """Two-tailed 95% t critical values (small df table + normal approx)."""
    table = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228}
    if df <= 0:
        return float("nan")
    if df in table:
        return table[df]
    if df <= 30:
        return 2.0 + (30 - df) * 0.01
    return 1.96


def welch_ttest(a: list[float], b: list[float]) -> dict[str, Any]:
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return {"error": "need at least 2 samples per group"}
    m1, m2 = statistics.mean(a), statistics.mean(b)
    v1, v2 = statistics.variance(a), statistics.variance(b)
    se = math.sqrt(v1 / n1 + v2 / n2)
    if se == 0:
        return {"t": 0.0, "df": n1 + n2 - 2, "p_approx": 1.0, "significant_95": False}
    t = (m1 - m2) / se
    num = (v1 / n1 + v2 / n2) ** 2
    den = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)
    df = num / den if den else n1 + n2 - 2
    tc = t_critical_95(int(round(df)))
    return {
        "mean_a_ms": round(m1, 1),
        "mean_b_ms": round(m2, 1),
        "t": round(t, 3),
        "df": round(df, 1),
        "t_crit_95": round(tc, 3),
        "significant_95": abs(t) > tc,
        "interpretation": "reject H0 (means differ)" if abs(t) > tc else "fail to reject H0",
    }


def ci_95(values: list[float]) -> dict[str, float]:
    clean = [v for v in values if v is not None and not math.isnan(v)]
    n = len(clean)
    m = statistics.mean(clean) if clean else float("nan")
    if n < 2:
        return {"mean": round(m, 1) if not math.isnan(m) else m, "ci_low": m, "ci_high": m, "n": n}
    s = statistics.stdev(clean)
    margin = t_critical_95(n - 1) * s / math.sqrt(n)
    return {"mean": round(m, 1), "ci_low": round(m - margin, 1), "ci_high": round(m + margin, 1), "n": n}


def task_hourly_cost() -> float:
    return TASK_VCPU * FARGATE_VCPU_HOUR + TASK_GB * FARGATE_GB_HOUR


def cost_per_1k_requests(run: RunMetrics) -> float:
    if run.http_reqs <= 0 or run.task_count is None:
        return float("nan")
    hours = run.duration_sec / 3600.0
    total_cost = task_hourly_cost() * run.task_count * hours
    return (total_cost / run.http_reqs) * 1000.0


def load_json_summaries(directory: Path) -> list[RunMetrics]:
    runs: list[RunMetrics] = []
    for path in sorted(directory.glob("*.json")):
        if path.name == "manifest.json" or path.name.endswith("_report.json"):
            continue
        try:
            runs.append(parse_summary(path))
        except (json.JSONDecodeError, KeyError) as exc:
            print(f"skip {path.name}: {exc}")
    return runs


def analyze_scale_out(directory: Path, out_dir: Path) -> None:
    runs = load_json_summaries(directory)
    if not runs:
        print(f"No summaries in {directory}")
        return

    by_tasks: dict[int, list[RunMetrics]] = {}
    for r in runs:
        if r.task_count is None:
            continue
        by_tasks.setdefault(r.task_count, []).append(r)

    lines = ["task_count,runs,p95_mean_ms,p95_ci_low,p95_ci_high,throughput_mean_rps,cost_per_1k_usd"]
    report_lines = ["# Scale-out analysis", ""]

    for tc in sorted(by_tasks):
        group = by_tasks[tc]
        p95s = [g.p95_ms for g in group]
        tps = [g.throughput_rps for g in group]
        costs = [cost_per_1k_requests(g) for g in group]
        p95_ci = ci_95(p95s)
        tp_mean = round(statistics.mean(tps), 2)
        cost_mean = round(statistics.mean([c for c in costs if not math.isnan(c)]), 4) if costs else float("nan")
        lines.append(f"{tc},{len(group)},{p95_ci['mean']},{p95_ci['ci_low']},{p95_ci['ci_high']},{tp_mean},{cost_mean}")
        report_lines.append(
            f"## {tc} task(s) (n={len(group)})\n"
            f"- p95 latency: {p95_ci['mean']} ms [{p95_ci['ci_low']}, {p95_ci['ci_high']}] 95% CI\n"
            f"- throughput: {tp_mean} req/s\n"
            f"- cost per 1k requests: ${cost_mean}\n"
        )

    # Linear scaling check: throughput vs task count
    if len(by_tasks) >= 2:
        counts = sorted(by_tasks)
        base_tp = statistics.mean([r.throughput_rps for r in by_tasks[counts[0]]])
        report_lines.append("## Linear scaling region")
        for tc in counts[1:]:
            tp = statistics.mean([r.throughput_rps for r in by_tasks[tc]])
            expected = base_tp * (tc / counts[0])
            ratio = tp / expected if expected else 0
            report_lines.append(
                f"- {tc} tasks: throughput {tp:.1f} req/s vs linear expectation {expected:.1f} ({ratio*100:.0f}% of ideal)"
            )

    csv_path = out_dir / "scale_out_summary.csv"
    md_path = out_dir / "scale_out_report.md"
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    md_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print(f"Wrote {csv_path} and {md_path}")
    _try_plot_scale_out(csv_path, out_dir)
    # Embed chart in markdown report (same directory as PNG)
    if (out_dir / "scale_out_charts.png").exists():
        chart_rel = "scale_out_charts.png"
        existing = md_path.read_text(encoding="utf-8")
        if chart_rel not in existing:
            md_path.write_text(existing + f"\n\n![Scale-out charts]({chart_rel})\n", encoding="utf-8")


def analyze_statistical(directory: Path, out_dir: Path) -> None:
    runs = load_json_summaries(directory)
    by_scenario: dict[str, list[float]] = {}
    for r in runs:
        by_scenario.setdefault(r.scenario, []).append(r.p95_ms)

    lines = ["# Statistical analysis (p95 latency, ms)", ""]
    for scenario, values in sorted(by_scenario.items()):
        ci = ci_95(values)
        lines.append(f"## {scenario} (n={ci['n']})")
        lines.append(f"- mean p95: {ci['mean']} ms, 95% CI [{ci['ci_low']}, {ci['ci_high']}]")
        lines.append("")

    if "feed" in by_scenario and "notifications" in by_scenario:
        test = welch_ttest(by_scenario["feed"], by_scenario["notifications"])
        lines.append("## Welch t-test: feed vs notifications (p95)")
        for k, v in test.items():
            lines.append(f"- {k}: {v}")
        if test.get("significant_95"):
            lines.append("- **Claim supported:** feed p95 is significantly different from notifications at α=0.05.")
        else:
            lines.append("- **Claim not supported** at α=0.05 (insufficient evidence or overlapping CIs).")
        lines.append("")

    md_path = out_dir / "statistical_report.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {md_path}")


def analyze_resilience(directory: Path, out_dir: Path) -> None:
    reports = sorted(directory.glob("*_report.json"))
    lines = ["# Resilience experiment results", ""]
    for rp in reports:
        data = json.loads(rp.read_text(encoding="utf-8-sig"))
        rec = data.get("recoverySec")
        lines.append(f"## {rp.name}")
        lines.append(f"- Task killed after: {data.get('killAfterSec')} s load")
        lines.append(f"- ALB unhealthy → healthy recovery: **{rec} s**" if rec else "- Recovery: not observed in poll window")
        lines.append(f"- k6 summary: `{data.get('summaryPath')}`")
        sp = data.get("summaryPath")
        if sp and Path(sp).exists():
            m = parse_summary(Path(sp), scenario="resilience")
            lines.append(f"- Post-failover p95: {m.p95_ms:.0f} ms, fail rate: {m.fail_rate*100:.2f}%")
        lines.append("")

    md_path = out_dir / "resilience_report.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {md_path}")


def _try_plot_scale_out(csv_path: Path, out_dir: Path) -> None:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed — skip charts (pip install matplotlib)")
        return

    tasks, p95, tp, cost = [], [], [], []
    for line in csv_path.read_text().strip().split("\n")[1:]:
        parts = line.split(",")
        tasks.append(int(parts[0]))
        p95.append(float(parts[2]))
        tp.append(float(parts[5]))
        cost.append(float(parts[6]))

    fig, axes = plt.subplots(1, 3, figsize=(12, 4))
    axes[0].plot(tasks, p95, "o-")
    axes[0].set_xlabel("Task count")
    axes[0].set_ylabel("p95 latency (ms)")
    axes[0].set_title("Latency vs tasks")

    axes[1].plot(tasks, tp, "o-")
    axes[1].set_xlabel("Task count")
    axes[1].set_ylabel("Throughput (req/s)")
    axes[1].set_title("Throughput vs tasks")

    axes[2].plot(tasks, cost, "o-")
    axes[2].set_xlabel("Task count")
    axes[2].set_ylabel("USD per 1k requests")
    axes[2].set_title("Cost curve")

    fig.tight_layout()
    chart = out_dir / "scale_out_charts.png"
    fig.savefig(chart, dpi=120)
    print(f"Wrote {chart}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze SquadUp k6 experiment results")
    parser.add_argument("--scale-out", type=Path, help="Directory with scale-out JSON summaries")
    parser.add_argument("--statistical", type=Path, help="Directory with repeated scenario summaries")
    parser.add_argument("--resilience", type=Path, help="Directory with resilience reports")
    parser.add_argument("--all", type=Path, help="Parent results directory (runs all sub-analyses)")
    parser.add_argument("--out", type=Path, help="Output directory (defaults to input dir)")
    args = parser.parse_args()

    if args.all:
        base = args.all
        analyze_scale_out(base / "scale-out", args.out or base / "scale-out")
        analyze_statistical(base / "statistical", args.out or base / "statistical")
        analyze_resilience(base / "resilience", args.out or base / "resilience")
        return

    if args.scale_out:
        analyze_scale_out(args.scale_out, args.out or args.scale_out)
    if args.statistical:
        analyze_statistical(args.statistical, args.out or args.statistical)
    if args.resilience:
        analyze_resilience(args.resilience, args.out or args.resilience)

    if not any([args.scale_out, args.statistical, args.resilience, args.all]):
        parser.print_help()


if __name__ == "__main__":
    main()

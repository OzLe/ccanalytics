"""Compare two replay pickles statement by statement (reference first, candidate second).

usage: python compare.py <ref.pickle> <cand.pickle> <log.jsonl>
"""
import collections
import json
import math
import pickle
import sys

ref = pickle.load(open(sys.argv[1], "rb"))
cand = pickle.load(open(sys.argv[2], "rb"))
sqls = [json.loads(line)["sql"] for line in open(sys.argv[3])]


def close(a, b):
    if isinstance(a, float) or isinstance(b, float):
        if a is None or b is None:
            return a is b
        try:
            return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-6)
        except (TypeError, ValueError):
            return False
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    return a == b


def key(row):
    return repr(tuple(round(x, 4) if isinstance(x, float) else x for x in row))


status = collections.Counter()
errors = collections.defaultdict(list)
mismatches = []
slower = []
for r, c in zip(ref["results"], cand["results"]):
    first = " ".join(sqls[r["i"]].split())[:90]
    if r["ok"] and not c["ok"]:
        status["regression (fails only on candidate)"] += 1
        errors[c["err"][:160]].append(first)
    elif not r["ok"] and c["ok"]:
        status["fixed (fails only on reference)"] += 1
    elif not r["ok"] and not c["ok"]:
        status["fails on both"] += 1
    elif r["rows"] is None and c["rows"] is None:
        status["same (no result set)"] += 1
    elif r["rows"] is None or c["rows"] is None or len(r["rows"]) != len(c["rows"]):
        status["mismatch: row count"] += 1
        mismatches.append((first, len(r["rows"] or []), len(c["rows"] or [])))
    elif all(close(x, y) for x, y in zip(r["rows"], c["rows"])):
        status["same result"] += 1
    elif all(close(x, y) for x, y in zip(sorted(r["rows"], key=key), sorted(c["rows"], key=key))):
        status["same rows, different order"] += 1
        mismatches.append(("ORDER " + first, len(r["rows"]), len(c["rows"])))
    else:
        status["mismatch: values"] += 1
        mismatches.append(("VALUES " + first, len(r["rows"]), len(c["rows"])))
    if r["ok"] and c["ok"] and r["ms"] > 5 and c["ms"] > 2 * r["ms"]:
        slower.append((c["ms"] / r["ms"], r["ms"], c["ms"], first))

print(f"reference {ref['version']}  candidate {cand['version']}  statements {len(ref['results'])}")
for k, v in status.most_common():
    print(f"  {v:5d}  {k}")
print("tables equal:", ref["tables"] == cand["tables"], " costs equal:",
      all(math.isclose(a or 0, b or 0, rel_tol=1e-12) for a, b in zip(ref["costs"], cand["costs"])))
if ref["tables"] != cand["tables"]:
    for t in sorted(set(ref["tables"]) | set(cand["tables"])):
        if ref["tables"].get(t) != cand["tables"].get(t):
            print(f"    {t}: {ref['tables'].get(t)} vs {cand['tables'].get(t)}")
print("distinct candidate-only errors:")
for err, firsts in sorted(errors.items(), key=lambda kv: -len(kv[1])):
    print(f"  x{len(firsts):4d}  {err}\n         e.g. {firsts[0]}")
print("mismatches (first 15):")
for m in mismatches[:15]:
    print("  ", m)
print(f"statements >2x slower on candidate (ref >5 ms): {len(slower)}")
for s in sorted(slower, reverse=True)[:8]:
    print(f"   {s[0]:.1f}x  {s[1]:.1f} -> {s[2]:.1f} ms  {s[3]}")
print(f"total replay time: {ref['seconds']:.1f}s vs {cand['seconds']:.1f}s")

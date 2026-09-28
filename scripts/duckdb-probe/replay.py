"""Replay the statements in a capture log (capture-sql.cjs) against a database copy with whichever duckdb
package this interpreter has, and pickle every statement's outcome. Writes to the copy. See README.md.

usage: python replay.py <db> <log.jsonl> <out.pickle>
"""
import datetime
import decimal
import json
import pickle
import sys
import time
import uuid

import duckdb

db, log_path, out_path = sys.argv[1:4]


def to_param(v):
    if isinstance(v, dict):
        if "$bigint" in v:
            return int(v["$bigint"])
        if "$date" in v:
            return v["$date"]
        if "$obj" in v:
            return v["str"]
        return {k: to_param(x) for k, x in v.items()}
    if isinstance(v, list):
        return [to_param(x) for x in v]
    return v


def norm(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, datetime.timedelta):
        return v.total_seconds()
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        return {str(k): norm(x) for k, x in v.items()}
    return v


con = duckdb.connect(db)
results = []
start = time.time()
with open(log_path) as f:
    for i, line in enumerate(f):
        entry = json.loads(line)
        sql = entry["sql"]
        values = entry.get("values")
        params = to_param(values) if values not in (None, [], {}) else None
        t0 = time.perf_counter()
        try:
            if params is None:
                con.execute(sql)
            else:
                con.execute(sql, params)
            rows = None
            if con.description is not None:
                rows = [tuple(norm(x) for x in r) for r in con.fetchall()]
            results.append({"i": i, "ok": True, "rows": rows, "ms": (time.perf_counter() - t0) * 1000})
        except Exception as e:  # noqa: BLE001 - every failure is data here
            results.append({"i": i, "ok": False, "err": f"{type(e).__name__}: {str(e)[:400]}",
                            "ms": (time.perf_counter() - t0) * 1000})

tables = {}
for (t,) in con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' ORDER BY 1").fetchall():
    tables[t] = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
costs = con.execute(
    "SELECT (SELECT SUM(cost_usd) FROM conversation_turns), (SELECT SUM(total_cost_usd) FROM sessions),"
    " (SELECT SUM(cost_usd) FROM sub_agents)").fetchone()
con.execute("CHECKPOINT")
con.close()

with open(out_path, "wb") as f:
    pickle.dump({"version": duckdb.__version__, "results": results, "tables": tables, "costs": costs,
                 "seconds": time.time() - start}, f)
ok = sum(r["ok"] for r in results)
print(f"{duckdb.__version__}: {ok}/{len(results)} statements ok in {time.time() - start:.1f}s")

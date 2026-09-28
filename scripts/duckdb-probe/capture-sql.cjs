// Preload (node --require): append every statement executed through @duckdb/node-api to $SQL_LOG as JSON lines
// {m, sql, values}. $CC_ROOT is the repo root; both copies of the package (root and dashboard) are patched.
// Prepared statements are logged when they run, with the values bound to them. Nested calls
// (runAndReadAll -> run) are logged once. See README.md.
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const log = fs.openSync(process.env.SQL_LOG, 'a');
const als = new AsyncLocalStorage();

function ser(_k, v) {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v && typeof v === 'object' && !Array.isArray(v) && v.constructor && v.constructor !== Object) {
    return { $obj: v.constructor.name, str: String(v) };
  }
  return v;
}

function write(entry) {
  fs.writeSync(log, JSON.stringify(entry, ser) + '\n');
}

function wrapExec(proto, name, describe) {
  const orig = proto[name];
  if (typeof orig !== 'function') return;
  proto[name] = function (...args) {
    if (als.getStore()) return orig.apply(this, args);
    return als.run(true, () => {
      write(describe.call(this, name, args));
      return orig.apply(this, args);
    });
  };
}

for (const root of [process.env.CC_ROOT, path.join(process.env.CC_ROOT, 'dashboard')]) {
  const api = require(path.join(root, 'node_modules/@duckdb/node-api'));
  const C = api.DuckDBConnection.prototype;
  const P = api.DuckDBPreparedStatement.prototype;
  if (C.__captured) continue;
  C.__captured = true;

  for (const m of ['run', 'runAndRead', 'runAndReadAll', 'runAndReadUntil', 'stream', 'streamAndRead',
    'streamAndReadAll', 'streamAndReadUntil', 'start', 'startStream']) {
    wrapExec(C, m, function (name, args) {
      return { m: name, sql: args[0], values: args[1] ?? null };
    });
  }

  const origPrepare = C.prepare;
  C.prepare = async function (sql, ...rest) {
    const stmt = await origPrepare.call(this, sql, ...rest);
    stmt.__sql = sql;
    stmt.__vals = [];
    return stmt;
  };

  for (const m of Object.getOwnPropertyNames(P).filter((n) => /^bind[A-Z]/.test(n))) {
    const orig = P[m];
    P[m] = function (index, value, ...rest) {
      if (this.__vals) this.__vals[index - 1] = m === 'bindNull' ? null : value;
      return orig.call(this, index, value, ...rest);
    };
  }
  const origBind = P.bind;
  P.bind = function (values, ...rest) {
    if (this.__vals) this.__vals = Array.isArray(values) ? [...values] : values;
    return origBind.call(this, values, ...rest);
  };
  const origClear = P.clearBindings;
  P.clearBindings = function (...rest) {
    if (this.__vals) this.__vals = [];
    return origClear.apply(this, rest);
  };

  for (const m of ['run', 'runAndRead', 'runAndReadAll', 'runAndReadUntil', 'stream', 'streamAndRead',
    'streamAndReadAll', 'streamAndReadUntil', 'start', 'startStream']) {
    wrapExec(P, m, function (name) {
      return { m: `prepared.${name}`, sql: this.__sql ?? null, values: this.__vals ?? null };
    });
  }
}

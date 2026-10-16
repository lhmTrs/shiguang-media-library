const databases = new WeakMap();

// Observe the shared database, not HTTP routes: scans and filesystem reconciliation write here too.
export class ReadCache {
  constructor(db, { ttl = 30000, max = 32, now = () => performance.now() } = {}) {
    this.entries = new Map();
    this.ttl = ttl;
    this.max = max;
    this.now = now;
    this.depth = 0;
    const invalidate = () => this.entries.clear();
    const prepare = db.prepare.bind(db);
    db.prepare = (...args) => {
      const statement = prepare(...args);
      const run = statement.run.bind(statement);
      statement.run = (...values) => {
        try { return run(...values); }
        finally { invalidate(); }
      };
      return statement;
    };
    const exec = db.exec.bind(db);
    db.exec = (...args) => {
      try { return exec(...args); }
      finally { invalidate(); }
    };
    const transaction = db.transaction.bind(db);
    db.transaction = fn => {
      const tx = transaction(fn);
      const cache = this;
      const wrap = action => function (...args) {
        cache.depth++;
        try { return action.apply(this, args); }
        finally { cache.depth--; invalidate(); }
      };
      const wrapped = wrap(tx);
      for (const mode of ["deferred", "immediate", "exclusive"]) {
        if (tx[mode]) wrapped[mode] = wrap(tx[mode]);
      }
      wrapped.default = wrapped;
      return wrapped;
    };
    this.db = db;
  }
  read(key, load) {
    // Never reuse or retain a view of partially committed data.
    if (this.depth || this.db.inTransaction) return load();
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) return structuredClone(cached.value);
    const value = load();
    if (!this.entries.has(key) && this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, { value: structuredClone(value), expires: this.now() + this.ttl });
    return value;
  }
}

export function observeDatabase(db) {
  let cache = databases.get(db);
  if (!cache) {
    cache = new ReadCache(db);
    databases.set(db, cache);
  }
  return cache;
}

export function cachedRead(db, key, load) {
  return observeDatabase(db).read(key, load);
}

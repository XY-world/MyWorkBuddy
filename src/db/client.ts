import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as schema from './schema';

const DATA_DIR = path.join(os.homedir(), '.myworkbuddy');
const DB_PATH = path.join(DATA_DIR, 'data.db');

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: SqlJsDatabase | null = null;
let _dirty = false;
let _flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * sql.js is pure JS/WASM — no native compilation needed.
 * Works in any Node.js or Electron version without rebuilding.
 *
 * Writes are batched: the DB is marked dirty and flushed to disk every 3s,
 * and also on explicit saveDb() calls (e.g. after migrations).
 */
export function getDb() {
  if (!_db) {
    throw new Error('DB not initialized — call initDb() first (async)');
  }
  return _dbProxy!;
}

export function getSqlite(): SqlJsDatabase {
  if (!_sqlite) {
    throw new Error('DB not initialized — call initDb() first (async)');
  }
  return _sqlite;
}

/** Must be called once at startup before any DB access */
export async function initDb(): Promise<void> {
  if (_db) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _sqlite = new SQL.Database(fileBuffer);
  } else {
    _sqlite = new SQL.Database();
  }

  _sqlite.run('PRAGMA foreign_keys = ON');
  _db = drizzle(_sqlite, { schema });
  _dbProxy = makeWriteProxy(_db);

  // Auto-flush every 3 seconds if dirty
  _flushTimer = setInterval(() => {
    if (_dirty) saveDb();
  }, 3000);
  // Don't keep Node.js process alive just for this timer
  if (_flushTimer.unref) _flushTimer.unref();
}

/** Flush the in-memory database to disk immediately */
export function saveDb(): void {
  if (!_sqlite) return;
  try {
    const data = _sqlite.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch { /* best-effort */ }
}

export function disposeDb(): void {
  if (_flushTimer) clearInterval(_flushTimer);
  saveDb();
  _sqlite?.close();
  _db = null;
  _sqlite = null;
  _dbProxy = null;
}

export { DATA_DIR, DB_PATH };

// ── Write proxy — marks DB dirty on any mutating call ─────────────────────────

let _dbProxy: ReturnType<typeof drizzle> | null = null;

function makeWriteProxy(db: ReturnType<typeof drizzle>): ReturnType<typeof drizzle> {
  return new Proxy(db, {
    get(target, prop) {
      const value = (target as any)[prop];
      // Intercept insert/update/delete builders — mark dirty when .run()/.get() is called
      if (prop === 'insert' || prop === 'update' || prop === 'delete') {
        return (...args: any[]) => {
          const builder = value.apply(target, args);
          return wrapBuilder(builder);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ReturnType<typeof drizzle>;
}

function wrapBuilder(builder: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      const value = target[prop];
      if (prop === 'run' || prop === 'get' || prop === 'all' || prop === 'returning') {
        return (...args: any[]) => {
          const result = typeof value === 'function' ? value.apply(target, args) : value;
          _dirty = true;
          // If returning() returns another builder, wrap it too
          if (prop === 'returning' && result && typeof result === 'object') {
            return wrapBuilder(result);
          }
          return result;
        };
      }
      // Chain: values(), set(), where() etc return new builders — keep wrapping
      if (typeof value === 'function') {
        return (...args: any[]) => {
          const result = value.apply(target, args);
          if (result && typeof result === 'object' && result !== target) {
            return wrapBuilder(result);
          }
          return result;
        };
      }
      return value;
    },
  });
}

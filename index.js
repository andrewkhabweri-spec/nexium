'use strict';

const util = require('util');
require('dotenv').config();
// const os = require('os');

// --- Basic module detection ---
function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

// --- Simple logger helper ---
const Logger = {
  debugEnabled: false,
  setDebug(v) { this.debugEnabled = !!v; },
  log(...args) { if (this.debugEnabled) console.log('[NEXIUM-ORM]', ...args); },
  warn(...args) { console.warn('[NEXIUM-ORM WARN]', ...args); },
  error(...args) { console.error('[NEXIUM-ORM ERR]', ...args); }
};

// --- DBError class ---
class DBError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DBError';
    this.meta = meta;
  }
}

// --- Simple in-memory cache (can be replaced by Redis adapter) ---
class SimpleCache {
  constructor() { this.map = new Map(); }
  get(k) { const e = this.map.get(k); if (!e) return null; if (e.ttl && Date.now() > e.ts + e.ttl) { this.map.delete(k); return null; } return e.v; }
  set(k, v, ttl = 0) { this.map.set(k, { v, ts: Date.now(), ttl }); }
  del(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

// --- DB core (driver-agnostic adapter) ---
class DB {
  static driver = null;         // 'mysql' | 'pg' | 'sqlite'
  static config = null;
  static pool = null;
  static debug = false;
  static cache = new SimpleCache();
  static eventHandlers = { query: [], error: [] };
  static retryAttempts = 1; // retries for transient errors

  /**
   * Initialize from env/config
   * options: { driver, debug, config, retryAttempts }
   */
  static initFromEnv({ driver = process.env.DB_CONNECTION || 'mysql', debug = process.env.DEBUG || false, config = null, retryAttempts = 1 } = {}) {
    this.driver = (driver || 'mysql').toLowerCase();
    this.debug = !!debug;
    Logger.setDebug(this.debug);
    this.retryAttempts = Math.max(1, Number(retryAttempts || 1));

    if (config) {
      this.config = config;
      return;
    }

    if (this.driver === 'sqlite') {
      this.config = { filename: process.env.DB_DATABASE || process.env.SQLITE_FILE || ':memory:' };
    } else if (this.driver === 'pg') {
      this.config = {
        host: process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1',
        user: process.env.DATABASE_USER || process.env.DB_USER || process.env.DB_USERNAME || 'postgres',
        password: process.env.DATABASE_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DATABASE_NAME || process.env.DB_NAME || process.env.DB_DATABASE || 'postgres',
        port: process.env.DATABASE_PORT ? Number(process.env.DB_PORT) : 5432,
        max: Number(process.env.DB_CONNECTION_LIMIT || 10)
      };
    } else { // mysql
      this.config = {
        host: process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1',
        user: process.env.DATABASE_USER || process.env.DB_USER || process.env.DB_USERNAME || 'root',
        password: process.env.DATABASE_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DATABASE_NAME || process.env.DB_NAME || process.env.DB_DATABASE || undefined,
        port: process.env.DATABASE_PORT ? Number(process.env.DB_PORT) : 3306,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
        queueLimit: 0,
        namedPlaceholders: false
      };
    }
  }

  static on(event, fn) {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = [];
    this.eventHandlers[event].push(fn);
  }

  static _emit(event, payload) {
    const handlers = this.eventHandlers[event] || [];
    for (const h of handlers) try { h(payload); } catch (e) { Logger.error('event handler error', e); }
  }

  static _ensureModule() {
    if (!this.driver) this.initFromEnv();
    if (this.driver === 'mysql') {
      const m = tryRequire('mysql2/promise');
      if (!m) throw new DBError('MySQL driver missing. Install: npm i mysql2');
      return { module: m, name: 'mysql2/promise' };
    } else if (this.driver === 'pg') {
      const m = tryRequire('pg');
      if (!m) throw new DBError('Postgres driver missing. Install: npm i pg');
      return { module: m, name: 'pg' };
    } else if (this.driver === 'sqlite') {
      const m = tryRequire('sqlite3');
      if (!m) throw new DBError('SQLite driver missing. Install: npm i sqlite3');
      return { module: m, name: 'sqlite3' };
    } else {
      throw new DBError('Unsupported DB driver: ' + this.driver);
    }
  }

  // Connect/create pool
  static async connect() {
    if (!this.driver) this.initFromEnv();
    if (this.pool) return this.pool;

    const info = this._ensureModule();
    if (this.driver === 'mysql') {
      // mysql2/promise
      this.pool = info.module.createPool(this.config);
      return this.pool;
    }

    if (this.driver === 'pg') {
      const { Pool } = info.module;
      this.pool = new Pool(this.config);
      // optional: bind error/reconnect events
      this.pool.on && this.pool.on('error', (err) => Logger.error('Postgres pool error', err));
      return this.pool;
    }

    if (this.driver === 'sqlite') {
      // sqlite3 with promisified Database
      const sqlite3 = info.module;
      sqlite3.verbose && sqlite3.verbose();
      const db = new sqlite3.Database(this.config.filename);
      // promisify get/all/run/exec
      db.runAsync = util.promisify(db.run.bind(db));
      db.getAsync = util.promisify(db.get.bind(db));
      db.allAsync = util.promisify(db.all.bind(db));
      db.execAsync = util.promisify(db.exec.bind(db));
      // wrapper emulating pool.query(sql, params) => [rows]
      this.pool = {
        __sqlite_db: db,
        query: async (sql, params = []) => {
          const s = sql.trim().toUpperCase();
          if (s.startsWith('SELECT') || s.startsWith('PRAGMA')) {
            const rows = await db.allAsync(sql, params);
            return [rows];
          } else {
            const res = await db.runAsync(sql, params);
            // emulate mysql/pg response
            return [{ lastInsertRowid: res.lastID, changes: res.changes }];
          }
        },
        exec: async (sql) => db.execAsync(sql),
        close: async () => new Promise((res, rej) => db.close((err) => err ? rej(err) : res()))
      };
      return this.pool;
    }

    throw new DBError('Failed to create DB pool');
  }

  static async end() {
    if (!this.pool) return;
    try {
      if (this.driver === 'mysql') await this.pool.end();
      else if (this.driver === 'pg') await this.pool.end();
      else if (this.driver === 'sqlite') await this.pool.close();
    } catch (e) {
      Logger.warn('Error closing pool', e);
    }
    this.pool = null;
  }

  static log(sql, params, timeMs = null) {
    const meta = { sql, params, timeMs, driver: this.driver };
    this._emit('query', meta);
    Logger.log(sql, params || []);
    if (timeMs != null && this.debug && timeMs > 0) {
      Logger.log(`[SQL ${timeMs}ms]`);
    }
  }

  // convert '?' placeholders to $1..$n for Postgres
  static _pgConvertPlaceholders(sql, params = []) {
    if (!params || !params.length) return { text: sql, values: params };
    let idx = 0;
    let out = '';
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '?') { idx++; out += '$' + idx; } else out += ch;
    }
    return { text: out, values: params };
  }

  // raw: returns rows directly (never nested [rows]) to keep API simple
  static async raw(sql, params = [], options = {}) {
    const { signal, normalize = false } = options;

    if (normalize && typeof sql === 'string') {
      sql = sql.trim().replace(/\s+/g, ' ');
    }

    let attempt = 0;
    const max = this.retryAttempts;

    while (attempt < max) {
      attempt++;
      const pool = await this.connect();
      const start = performance.now();

      try {
        this.log(sql, params, null, { attempt });

        if (this.driver === 'mysql') {
          const [rows] = await pool.query(sql, params, { signal });
          const time = performance.now() - start;
          this.log(sql, params, time.toFixed(2));
          return rows;
        }

        if (this.driver === 'sqlite') {
          const [rows] = await pool.query(sql, params, { signal });
          const time = performance.now() - start;
          this.log(sql, params, time.toFixed(2));
          return rows;
        }

        if (this.driver === 'pg') {
          const { text, values } = this._pgConvertPlaceholders(sql, params);
          if (signal) signal.throwIfAborted?.();
          const res = await pool.query(text, values, { signal });
          const time = performance.now() - start;
          this.log(text, values, time.toFixed(2));
          return res.rows;
        }

        throw new DBError('Unsupported driver in raw()');

      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();

        this._emit('error', { err, sql, params, attempt });

        if (
          attempt < max &&
          (msg.includes('dead') ||
          msg.includes('lost') ||
          msg.includes('timeout') ||
          err?.code === 'PROTOCOL_CONNECTION_LOST' ||
          err?.code === 'ECONNRESET')
        ) {
          Logger.warn('Transient DB error → retrying', { attempt, msg });

          try { await this.end(); } catch {}

          // Exponential backoff + jitter
          const base = 80;
          const cap  = 1200;
          const exp  = Math.min(cap, base * 2 ** attempt);
          const jitter = Math.random() * 150;
          const delay = Math.floor(exp + jitter);

          await new Promise(res => setTimeout(res, delay));
          continue;
        }

        // Wrap non-retryable error
        throw new DBError(
          `DB raw() failed on attempt ${attempt}: ${err?.message || err}`,
          { original: err, sql, params }
        );
      }
    }

    // Exhausted retries
    throw new DBError('DB raw(): exhausted all retry attempts', { sql, params });
  }

  static async transaction(fn) {
    if (!this.driver) this.initFromEnv();
    const pool = await this.connect();
    if (this.driver === 'mysql') {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const res = await fn(conn);
        await conn.commit();
        conn.release();
        return res;
      } catch (err) {
        try { await conn.rollback(); } catch(e) {}
        conn.release();
        throw err;
      }
    } else if (this.driver === 'pg') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn(client);
        await client.query('COMMIT');
        client.release();
        return res;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch(e) {}
        client.release();
        throw err;
      }
    } else if (this.driver === 'sqlite') {
      const db = pool.__sqlite_db;
      try {
        await db.execAsync('BEGIN');
        const res = await fn({
          query: async (sql, params = []) => {
            // return object like pg client does
            const s = sql.trim().toUpperCase();
            if (s.startsWith('SELECT')) {
              const rows = await db.allAsync(sql, params);
              return { rows };
            } else {
              const info = await db.runAsync(sql, params);
              return { info };
            }
          }
        });
        await db.execAsync('COMMIT');
        return res;
      } catch (err) {
        try { await db.execAsync('ROLLBACK'); } catch (e) {}
        throw err;
      }
    } else {
      throw new DBError('Unsupported driver for transactions');
    }
  }

  // driver-specific identifier escaping
  static escapeId(identifier) {
    if (identifier === '*') return '*';
    if (typeof identifier !== 'string') identifier = String(identifier);
    // if contains spaces or parentheses, treat as expression
    if (/\s|\(|\)/.test(identifier) || / as /i.test(identifier)) return identifier;
    if (this.driver === 'pg') {
      return '"' + identifier.replace(/"/g, '""') + '"';
    }
    // mysql/sqlite use backticks
    return '`' + identifier.replace(/`/g, '``') + '`';
  }

  // convenience for caching queries
  static async cached(sql, params = [], ttlMs = 0) {
    const key = JSON.stringify([sql, params]);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = await this.raw(sql, params);
    this.cache.set(key, rows, ttlMs);
    return rows;
  }
}
// expose escapeId helper
const escapeId = (s) => DB.escapeId(s);

// -----------------------------
// MAIN Validator
// -----------------------------
class Validator {
  constructor(data = {}, id = null, table = null, rules = {}, customMessages = {}, db = null) {
    this.data = data || {};
    this.id = id === undefined || id === null ? null : id;
    this.table = table || null;
    this.rules = rules || {};
    this.customMessages = customMessages || {};
    this.errorBag = {};
    this.primaryKey = 'id';
    this.db = db || (typeof DB !== 'undefined' ? DB : null);
  }

  // -----------------------------
  // SANITIZATION
  // -----------------------------
  _sanitizeInput(data) {
    const sanitized = {};
    for (let key in data) {
      let val = data[key];

      // Trim strings
      if (typeof val === 'string') val = val.trim();

      // Normalize booleans
      if (val === 'true' || val === 1 || val === '1') val = true;
      if (val === 'false' || val === 0 || val === '0') val = false;

      // Normalize numeric strings
      if (!isNaN(val) && val !== '' && typeof val !== 'boolean') val = Number(val);

      sanitized[key] = val;
    }
    return sanitized;
  }

  // -----------------------------
  // MAIN
  // -----------------------------
  async fails() {
    this.errorBag = {};

    for (const field in this.rules) {
      let rulesArray = this.rules[field];
      const hasField = field in this.data;
      const value = this.data[field];

      if (typeof rulesArray === 'string') rulesArray = rulesArray.split('|');
      if (!Array.isArray(rulesArray)) throw new Error(`Rules for field "${field}" must be array/string.`);

      const isSometimes = rulesArray.includes('sometimes');
      const isNullable = rulesArray.includes('nullable');

      rulesArray = rulesArray.filter(r => r !== 'sometimes' && r !== 'nullable');

      // 1️⃣ Sometimes: skip entirely if field not present
      if (isSometimes && !hasField) continue;

      // 2️⃣ Nullable: skip rules if value empty
      const isEmpty = value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '');
      if (isNullable && isEmpty) continue;

      // 3️⃣ Validate remaining rules
      for (let rule of rulesArray) {
        const [ruleName, ...paramParts] = rule.split(':');
        const paramRaw = paramParts.join(':');
        const params = paramRaw ? paramRaw.split(',') : [];

        const methodName = `validate${ruleName.charAt(0).toUpperCase() + ruleName.slice(1)}`;
        if (typeof this[methodName] !== 'function') throw new Error(`Validation rule "${ruleName}" does not exist.`);

        if (['unique', 'exists'].includes(ruleName)) {
          await this[methodName](field, ...params);
        } else {
          this[methodName](field, ...params);
        }
      }
    }

    return Object.keys(this.errorBag).length > 0;
  }


  passes() {
    return !Object.keys(this.errorBag).length;
  }

  getErrors() {
    return this.errorBag;
  }

  addError(field, message) {
    if (!this.errorBag[field]) this.errorBag[field] = [];
    this.errorBag[field].push(message);
  }

  msg(field, rule, fallback) {
    return this.customMessages[`${field}.${rule}`] || this.customMessages[rule] || fallback;
  }

  toNumber(val) {
    return val === undefined || val === null || val === "" ? null : Number(val);
  }

  // -----------------------------
  // CORE RULES
  // -----------------------------
  validateRequired(field) {
    const value = this.data[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      this.addError(field, this.msg(field, 'required', `${field} is required.`));
    }
  }

  validateString(field) {
    const value = this.data[field];
    if (typeof value !== 'string') {
      this.addError(field, this.msg(field, 'string', `${field} must be a string.`));
    }
  }

  validateBoolean(field) {
    const value = this.data[field];
    const allowed = [true, false, 1, 0, "1", "0", "true", "false"];

    if (!allowed.includes(value)) {
      this.addError(field, this.msg(field, 'boolean', `${field} must be boolean`));
    }
  }

  validateNumeric(field) {
    const value = this.data[field];
    if (isNaN(Number(value))) {
      this.addError(field, this.msg(field, 'numeric', `${field} must be numeric.`));
    }
  }

  validateInteger(field) {
    if (!Number.isInteger(Number(this.data[field]))) {
      this.addError(field, this.msg(field, 'integer', `${field} must be integer.`));
    }
  }

  validateEmail(field) {
    const value = String(this.data[field]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.addError(field, this.msg(field, 'email', `${field} must be valid email.`));
    }
  }

  validateMin(field, min) {
    const value = this.data[field];
    min = Number(min);

    // number
    if (!isNaN(value)) {
      if (Number(value) < min) {
        this.addError(field, this.msg(field, 'min', `${field} must be at least ${min}`));
      }
      return;
    }
    // array
    if (Array.isArray(value)) {
      if (value.length < min) {
        this.addError(
          field,
          this.msg(field, 'min', `${field} must contain at least ${min} item(s)`)
        );
      }
      return;
    }
    // string
    if (String(value).length < min) {
      this.addError(field, this.msg(field, 'min', `${field} must be at least ${min} characters`));
    }
  }



  validateMax(field, max) {
    const value = this.data[field];
    max = Number(max);

    // number
    if (!isNaN(value)) {
      if (Number(value) > max) {
        this.addError(field, this.msg(field, 'max', `${field} must not exceed ${max}`));
      }
      return;
    }

    // array
    if (Array.isArray(value)) {
      if (value.length > max) {
        this.addError(
          field,
          this.msg(field, 'max', `${field} must not contain more than ${max} item(s)`)
        );
      }
      return;
    }

    // string
    if (String(value).length > max) {
      this.addError(field, this.msg(field, 'max', `${field} must not exceed ${max} characters`));
    }
  }

  validateConfirmed(field) {
    const value = this.data[field];
    const confirm = this.data[field + '_confirmation'];
    if (value !== confirm) {
      this.addError(field, this.msg(field, 'confirmed', `${field} confirmation does not match.`));
    }
  }

  validateDate(field) {
    if (isNaN(Date.parse(this.data[field]))) {
      this.addError(field, this.msg(field, 'date', `${field} must be valid date.`));
    }
  }

  validateUrl(field) {
    try { new URL(String(this.data[field])); }
    catch { this.addError(field, this.msg(field, 'url', `${field} must be valid URL.`)); }
  }

  validateIp(field) {
    const value = String(this.data[field]);
    const regex = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
    if (!regex.test(value)) {
      this.addError(field, this.msg(field, 'ip', `${field} must be valid IPv4 address.`));
    }
  }

    validateUuid(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val))) {
      this.addError(field, this.msg(field, 'uuid', `${field} must be a valid UUID.`));
    }
  }

  validateSlug(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(val))) {
      this.addError(field, this.msg(field, 'slug', `${field} must be a valid slug.`));
    }
  }

  validateAfter(field, dateField) {
    const val = this.data[field];
    const other = this.data[dateField];
    if (!val || !other) return;
    const a = Date.parse(val);
    const b = Date.parse(other);
    if (isNaN(a) || isNaN(b)) return;
    if (a <= b) {
      this.addError(field, this.msg(field, 'after', `${field} must be a date after ${dateField}.`));
    }
  }

  validateBefore(field, dateField) {
    const val = this.data[field];
    const other = this.data[dateField];
    if (!val || !other) return;
    const a = Date.parse(val);
    const b = Date.parse(other);
    if (isNaN(a) || isNaN(b)) return;
    if (a >= b) {
      this.addError(field, this.msg(field, 'before', `${field} must be a date before ${dateField}.`));
    }
  }

  validateRegex(field, pattern) {
    const val = this.data[field];
    if (!val) return;
    let regex;
    try {
      if (/^\/.*\/[gimsuy]*$/.test(pattern)) {
        const lastSlash = pattern.lastIndexOf('/');
        const body = pattern.slice(1, lastSlash);
        const flags = pattern.slice(lastSlash + 1);
        regex = new RegExp(body, flags);
      } else {
        regex = new RegExp(pattern);
      }
    } catch (e) {
      throw new Error(`Invalid regex pattern for ${field}: ${pattern}`);
    }

    if (!regex.test(String(val))) {
      this.addError(field, this.msg(field, 'regex', `${field} format is invalid.`));
    }
  }

  validateIn(field, ...values) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const normalizedValues = values.map(v => String(v));
    if (!normalizedValues.includes(String(val))) {
      this.addError(field, this.msg(field, 'in', `${field} must be one of [${values.join(', ')}].`));
    }
  }

  validateNotIn(field, ...values) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const normalizedValues = values.map(v => String(v));
    if (normalizedValues.includes(String(val))) {
      this.addError(field, this.msg(field, 'not_in', `${field} must not be one of [${values.join(', ')}].`));
    }
  }

  // -----------------------------
  // HARDENED DB RULES
  // -----------------------------
  async validateUnique(field, table = null, column = null, ignore = null, pk = null) {
    if (!this.db) throw new Error("Database required for unique rule");
    const value = this.data[field];
    if (value === undefined || value === null || value === '') return;

    table  = table  || this.table;
    column = column || field;
    ignore = (ignore === undefined || ignore === null || ignore === '') ? this.id : ignore;
    pk     = pk || this.primaryKey;

    if (!table) throw new Error(`Unique rule requires a table. Example: unique:users,email`);

    const qb = new QueryBuilder(table)
      .select('1')
      .where(column, value);

    // Only ignore when we have an ID
    if (ignore !== null) {
      qb.whereNot(pk, ignore);
    }

    const exists = await qb.exists();
    if (exists === true) {
      this.addError(field, this.msg(field, 'unique', `${field} has already been taken.`));
    }
  }

  async validateExists(field, table = null, column = null, whereColumn = null, whereValue = null) {
    if (!this.db) throw new Error("Database required for exists rule");
    const value = this.data[field];
    if (value === undefined || value === null || value === '') return;

    table  = table  || this.table;
    column = column || field;

    if (!table) throw new Error(`Exists validation for "${field}" requires a table. Example: exists:users,id`);

    const qb = new QueryBuilder(table)
      .select('1')
      .where(column, value);

    if (whereColumn && whereValue !== undefined && whereValue !== null) {
      qb.where(whereColumn, whereValue);
    }

    const found = await qb.exists();
    if (!found) {
      this.addError(field, this.msg(field, 'exists', `${field} does not exist in ${table}.`));
    }
  }

    validatePhone(field) {
    const val = this.data[field];
    if (!val) return;
    const s = String(val);
    const phoneRegex = /^(0\d{9}|\+[1-9]\d{6,14})$/;
    if (!phoneRegex.test(s)) {
      this.addError(field, this.msg(field, 'phone', `${field} must be a valid phone number.`));
    }
  }

  validateAlpha(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[A-Za-z]+$/.test(String(val))) {
      this.addError(field, this.msg(field, 'alpha', `${field} must contain only letters.`));
    }
  }

  validateAlphaNum(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[A-Za-z0-9]+$/.test(String(val))) {
      this.addError(field, this.msg(field, 'alpha_num', `${field} must contain only letters and numbers.`));
    }
  }

  validateArray(field) {
    const val = this.data[field];
    if (val === undefined) return;
    if (!Array.isArray(val)) this.addError(field, this.msg(field, 'array', `${field} must be an array.`));
  }

  validateJson(field) {
    const val = this.data[field];
    if (!val) return;
    try { JSON.parse(String(val)); }
    catch (e) { this.addError(field, this.msg(field, 'json', `${field} must be valid JSON.`)); }
  }

  validateBetween(field, min, max) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const nMin = Number(min), nMax = Number(max);
    if ((typeof val === 'number' && (val < nMin || val > nMax)) ||
      ((typeof val === 'string' || Array.isArray(val)) && (val.length < nMin || val.length > nMax)) ||
      (!isNaN(Number(val)) && (Number(val) < nMin || Number(val) > nMax))) {
      this.addError(field, this.msg(field, 'between', `${field} must be between ${min} and ${max}.`));
    }
  }

  // -----------------------------
  // FILE RULES HARDENED
  // -----------------------------
  validateFile(field) {
    const value = this.data[field];
    if (!value || typeof value !== 'object' || (!value.name && !value.size)) {
      this.addError(field, this.msg(field, 'file', `${field} must be valid file upload.`));
    }
  }

  validateImage(field) {
    const value = this.data[field];
    if (!value || !value.name) {
      this.addError(field, this.msg(field, 'image', `${field} must be valid image file.`));
      return;
    }
    const ext = value.name.split('.').pop().toLowerCase();
    if (!['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) {
      this.addError(field, this.msg(field, 'image', `${field} must be valid image file.`));
    }
  }

  validateMimes(field, types) {
    const value = this.data[field];
    if (!value || !value.name) return;

    const allowed = types.split(',').map(t => t.trim().toLowerCase());
    const ext = value.name.split('.').pop().toLowerCase();

    if (!allowed.includes(ext)) {
      this.addError(field, this.msg(field, 'mimes', `${field} must be of type: ${types}.`));
    }
  }

  validateSize(field, maxKB) {
    const value = this.data[field];
    if (!value || !value.size) return;
    const max = Number(maxKB) * 1024;
    if (value.size > max) {
      this.addError(field, this.msg(field, 'size', `${field} must not exceed ${maxKB} KB.`));
    }
  }
}


// Lightweight date/time utilities — cleaned & production-ready
// Exports: { DateTime, Duration, Interval, Info, parseFromFormat }

'use strict';

// ============================================================================
// UTILITIES
// ============================================================================
const _isNumber = (v) => typeof v === 'number' && !Number.isNaN(v);

function _normalizeZone(zone) {
  if (!zone || zone === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  if (String(zone).toLowerCase() === 'utc') return 'UTC';
  return String(zone);
}

const pad = (num, len = 2) => String(num).padStart(len, '0');

// ============================================================================
// DURATION
// ============================================================================
class Duration {
  constructor({ milliseconds = 0, seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) {
    this.millis =
      Number(milliseconds) +
      Number(seconds) * 1000 +
      Number(minutes) * 60000 +
      Number(hours) * 3600000 +
      Number(days) * 86400000;
    if (!Number.isFinite(this.millis)) throw new Error('Invalid Duration values');
    Object.freeze(this);
  }

  static fromObject(obj = {}) {
    return new Duration(obj);
  }

  static fromMillis(ms) {
    return new Duration({ milliseconds: ms });
  }

  plus(other) {
    const dur = other instanceof Duration ? other : Duration.fromObject(other);
    return Duration.fromMillis(this.millis + dur.millis);
  }

  minus(other) {
    const dur = other instanceof Duration ? other : Duration.fromObject(other);
    return Duration.fromMillis(this.millis - dur.millis);
  }

  as(unit = 'milliseconds') {
    switch (unit) {
      case 'milliseconds':
        return this.millis;
      case 'seconds':
        return this.millis / 1000;
      case 'minutes':
        return this.millis / 60000;
      case 'hours':
        return this.millis / 3600000;
      case 'days':
        return this.millis / 86400000;
      default:
        throw new Error('Unsupported Duration unit: ' + unit);
    }
  }

  toISO() {
    // ISO-like "PT<n.nnn>S"
    const seconds = this.millis / 1000;
    return `PT${seconds.toFixed(3)}S`;
  }
}

// ============================================================================
// FORMAT TOKENS
// ============================================================================
const FORMAT_TOKENS = {
  yyyy: /\d{4}/,
  yy: /\d{2}/,
  MM: /\d{2}/,
  M: /\d{1,2}/,
  dd: /\d{2}/,
  d: /\d{1,2}/,
  HH: /\d{2}/,
  H: /\d{1,2}/,
  hh: /\d{2}/,
  h: /\d{1,2}/,
  mm: /\d{2}/,
  ss: /\d{2}/,
  SSS: /\d{1,3}/,
  a: /(AM|PM)/i,
  ZZ: /[+-]\d{2}:\d{2}/, // +02:00
  Z: /[+-]\d{4}/ // +0200
};

// map tokens to internal keys used by parseFromFormat
const TOKEN_MAP = {
  yyyy: 'year',
  yy: 'year2',
  MM: 'month',
  M: 'month',
  dd: 'day',
  d: 'day',
  HH: 'hour24',
  H: 'hour24',
  hh: 'hour12',
  h: 'hour12',
  mm: 'minute',
  ss: 'second',
  SSS: 'millisecond',
  a: 'ampm',
  Z: 'offset',
  ZZ: 'offset'
};

// create token list sorted by length descending so longer tokens match first
const TOKEN_KEYS_SORTED = Object.keys(FORMAT_TOKENS).sort((a, b) => b.length - a.length);

// ============================================================================
// PARSER
// ============================================================================
function parseFromFormat(input, fmt) {
  if (typeof input !== 'string' || typeof fmt !== 'string') throw new Error('parseFromFormat expects strings');
  let ptrInput = 0;
  let ptrFmt = 0;
  const out = {};

  while (ptrFmt < fmt.length) {
    // find token that matches the substring of fmt at ptrFmt
    const token = TOKEN_KEYS_SORTED.find((t) => fmt.startsWith(t, ptrFmt));
    if (token) {
      const regex = new RegExp('^' + FORMAT_TOKENS[token].source);
      const slice = input.slice(ptrInput);
      const match = slice.match(regex);
      if (!match) {
        throw new Error(`Invalid ${token} in "${input}" (expected ${FORMAT_TOKENS[token]})`);
      }
      const val = match[0];
      ptrInput += val.length;
      ptrFmt += token.length;
      const key = TOKEN_MAP[token];
      out[key] = val;
      continue;
    }

    // literal character: must match exactly
    const expectedChar = fmt[ptrFmt];
    const actualChar = input[ptrInput];
    if (actualChar !== expectedChar) {
      // include context in message
      throw new Error(
        `Unexpected character at position ${ptrInput}: expected "${expectedChar}" got "${actualChar || 'end-of-string'}"`
      );
    }
    ptrFmt += 1;
    ptrInput += 1;
  }

  if (ptrInput !== input.length) {
    // leftover characters in input
    throw new Error(`Extra characters in input starting at position ${ptrInput}`);
  }

  // Build components (defaults)
  const year = out.year ? Number(out.year) : out.year2 ? 2000 + Number(out.year2) : new Date().getUTCFullYear();
  const month = out.month ? Number(out.month) : 1;
  const day = out.day ? Number(out.day) : 1;

  let hour = 0;
  if (out.hour24 !== undefined) hour = Number(out.hour24);
  if (out.hour12 !== undefined) {
    const h = Number(out.hour12);
    const isPM = (out.ampm || '').toUpperCase() === 'PM';
    hour = (h % 12) + (isPM ? 12 : 0);
  }

  const minute = out.minute ? Number(out.minute) : 0;
  const second = out.second ? Number(out.second) : 0;
  const ms = out.millisecond ? Number(out.millisecond) : 0;

  // parse offset (Z or ZZ)
  let zoneOffsetMinutes = 0;
  if (out.offset) {
    // support both +0200 and +02:00
    const o = out.offset.replace(':', '');
    const sign = o[0] === '-' ? -1 : 1;
    const hh = Number(o.slice(1, 3)) || 0;
    const mm = Number(o.slice(3, 5)) || 0;
    zoneOffsetMinutes = sign * (hh * 60 + mm);
  }

  // Create UTC instant from parsed values and offset.
  // Components are interpreted as values in the offset timezone; convert to UTC instant.
  const utcMillisOfLocal = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const final = utcMillisOfLocal - zoneOffsetMinutes * 60000;
  return new Date(final);
}

// ============================================================================
// DATETIME
// ============================================================================
/**
 * @typedef {Object} DateTimeOptions
 * @property {string} [zone]
 * @property {string} [locale]
 */
class DateTime {
  /**
   * @param {Date|string|number} date
   * @param {DateTimeOptions} [options]
   */
  constructor(date, { zone = 'local', locale } = {}) {
    let jsDate = date instanceof Date ? new Date(date.valueOf()) : new Date(date);
    if (Number.isNaN(jsDate.valueOf())) throw new Error('Invalid Date');

    this._date = new Date(jsDate.valueOf());
    this.zone = _normalizeZone(zone);
    this.locale = locale;

    Object.freeze(this);
  }

  static now(opts = {}) {
    return new DateTime(new Date(), opts);
  }
  static fromJSDate(jsDate, opts = {}) {
    return new DateTime(jsDate, opts);
  }
  static fromMillis(ms, opts = {}) {
    return new DateTime(new Date(Number(ms)), opts);
  }
  static fromISO(iso, opts = {}) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new Error('Invalid ISO string');
    return new DateTime(new Date(ms), opts);
  }

  static fromObject(obj = {}) {
    // Treat provided components as UTC components.
    const {
      year = 1970,
      month = 1,
      day = 1,
      hour = 0,
      minute = 0,
      second = 0,
      millisecond = 0,
      zone = 'UTC',
      locale
    } = obj;
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    return new DateTime(d, { zone, locale });
  }

  static fromFormat(str, fmt, opts = {}) {
    const d = parseFromFormat(str, fmt);
    return new DateTime(d, opts);
  }

  toJSDate() {
    return new Date(this._date.valueOf());
  }
  toMillis() {
    return this._date.valueOf();
  }
  toUTC() {
    return this.setZone('UTC');
  }
  toLocal() {
    return this.setZone('local');
  }

  setZone(zone) {
    const z = _normalizeZone(zone);
    if (z === this.zone) return this;
    return new DateTime(this._date, { zone: z, locale: this.locale });
  }

  setLocale(locale) {
    if (locale === this.locale) return this;
    return new DateTime(this._date, { zone: this.zone, locale });
  }

  plus(dur) {
    const d = dur instanceof Duration ? dur : Duration.fromObject(dur);
    return DateTime.fromMillis(this.toMillis() + d.millis, { zone: this.zone, locale: this.locale });
  }

  minus(dur) {
    const d = dur instanceof Duration ? dur : Duration.fromObject(dur);
    return DateTime.fromMillis(this.toMillis() - d.millis, { zone: this.zone, locale: this.locale });
  }

  diff(other) {
    const ms =
      other instanceof DateTime ? other.toMillis() : DateTime.fromJSDate(new Date(other)).toMillis();
    return Duration.fromMillis(this.toMillis() - ms);
  }

  toISO() {
    return new Date(this._date.valueOf()).toISOString();
  }
  toISOString() {
    return this.toISO();
  }

  // -----------------------------
  // toFormat (supports most common tokens)
  // -----------------------------
  toFormat(fmtStr) {
    if (typeof fmtStr !== 'string') throw new Error('toFormat expects a format string');

    const d = this._date;

    // 24hr parts
    const parts24 = new Intl.DateTimeFormat(this.locale || 'en', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      fractionalSecondDigits: 3,
      timeZone: this.zone
    }).formatToParts(d);

    // 12hr parts
    const parts12 = new Intl.DateTimeFormat(this.locale || 'en', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: this.zone
    }).formatToParts(d);

    const map = {};
    for (const p of parts24) {
      if (p.type === 'literal') continue;
      // keep strings here (formatToParts returns strings)
      map[p.type] = p.value;
    }
    // add dayPeriod from 12hr parts if present
    for (const p of parts12) {
      if (p.type === 'dayPeriod') map.dayPeriod = p.value;
      if (p.type === 'hour' && !map['hour12']) map['hour12'] = p.value;
    }

    const hour24 = map.hour || '00';
    const hour12 = map.hour12 || '12';
    const minute = map.minute || '00';
    const second = map.second || '00';

    // fractionalSecond may be present (string like "123")
    const frac = map.fractionalSecond !== undefined ? map.fractionalSecond : null;
    const ssMill = frac !== null ? String(frac).padStart(3, '0') : String(d.getUTCMilliseconds()).padStart(3, '0');

    const safeMap = {
      yyyy: map.year || String(new Date(d.valueOf()).getUTCFullYear()),
      yy: (map.year || String(new Date(d.valueOf()).getUTCFullYear())).slice(-2),
      MM: map.month || '01',
      M: String(Number(map.month || '1')),
      dd: map.day || '01',
      d: String(Number(map.day || '1')),
      HH: hour24,
      H: String(Number(hour24)),
      hh: hour12,
      h: String(Number(hour12)),
      mm: minute,
      ss: second,
      SSS: ssMill,
      a: (map.dayPeriod || 'AM').toUpperCase()
    };

    // Replace tokens — the regex orders tokens by length implicitly due to alternation
    return fmtStr.replace(/yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|ss|SSS|a/g, (t) => safeMap[t]);
  }

  // -----------------------------
  // startOf / endOf (UTC-based arithmetic)
  // zone is only used for formatting; arithmetic is on the instant (UTC).
  // -----------------------------
  startOf(unit) {
    const ms = this.toMillis();
    const dt = new Date(ms); // UTC instant
    const res = new Date(dt.valueOf());

    switch (unit) {
      case 'year':
        res.setUTCFullYear(res.getUTCFullYear(), 0, 1);
        res.setUTCHours(0, 0, 0, 0);
        break;
      case 'month':
        res.setUTCDate(1);
        res.setUTCHours(0, 0, 0, 0);
        break;
      case 'week': {
        // Week starts on Sunday (0)
        const day = res.getUTCDay(); // 0..6
        res.setUTCDate(res.getUTCDate() - day);
        res.setUTCHours(0, 0, 0, 0);
        break;
      }
      case 'day':
        res.setUTCHours(0, 0, 0, 0);
        break;
      case 'hour':
        res.setUTCMinutes(0, 0, 0);
        break;
      case 'minute':
        res.setUTCSeconds(0, 0);
        break;
      case 'second':
        res.setUTCMilliseconds(0);
        break;
      default:
        throw new Error('Invalid unit for startOf: ' + unit);
    }
    return new DateTime(res, { zone: this.zone, locale: this.locale });
  }

  endOf(unit) {
    // compute startOf next unit and subtract 1 ms
    let startNext;
    switch (unit) {
      case 'year':
        // first instant of next year
        startNext = new Date(Date.UTC(this.year() + 1, 0, 1, 0, 0, 0, 0));
        startNext = new DateTime(startNext, { zone: this.zone, locale: this.locale });
        break;
      case 'month': {
        // first instant of next month
        // month() returns 1..12, Date.UTC month is zero-based so use this.month() as the *next* month index
        const y = this.year();
        const m = this.month(); // 1..12
        // Date.UTC expects zero-based month; m is 1..12 so using m gives next month index (0-based).
        startNext = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
        startNext = new DateTime(startNext, { zone: this.zone, locale: this.locale });
        break;
      }
      case 'week':
        startNext = this.startOf('week').plus({ days: 7 });
        break;
      case 'day':
        startNext = this.startOf('day').plus({ days: 1 });
        break;
      case 'hour':
        startNext = this.startOf('hour').plus({ hours: 1 });
        break;
      case 'minute':
        startNext = this.startOf('minute').plus({ minutes: 1 });
        break;
      case 'second':
        startNext = this.startOf('second').plus({ seconds: 1 });
        break;
      default:
        throw new Error('Invalid unit for endOf: ' + unit);
    }

    return DateTime.fromMillis(startNext.toMillis() - 1, { zone: this.zone, locale: this.locale });
  }

  _getParts() {
    // returns numeric parts (localized to configured zone using Intl)
    const parts = new Intl.DateTimeFormat(this.locale || 'en', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      fractionalSecondDigits: 3,
      hour12: false,
      timeZone: this.zone
    }).formatToParts(this._date);

    const obj = {};
    for (const p of parts) {
      if (p.type === 'literal') continue;
      if (p.type === 'fractionalSecond') {
        obj[p.type] = Number(p.value);
      } else if (/^\d+$/.test(p.value)) {
        obj[p.type] = Number(p.value);
      } else {
        // non-numeric (like dayPeriod) skip or keep as-is if desired
      }
    }
    return obj;
  }

  // convenience getters (obtained using formatToParts in configured zone)
  year() {
    return this._getParts().year;
  }
  month() {
    return this._getParts().month;
  }
  day() {
    return this._getParts().day;
  }
  hour() {
    return this._getParts().hour;
  }
  minute() {
    return this._getParts().minute;
  }
  second() {
    return this._getParts().second;
  }
  millisecond() {
    return this._getParts().fractionalSecond || 0;
  }
  equals(other) {
    return other instanceof DateTime && this.toMillis() === other.toMillis();
  }
}

// ============================================================================
// INTERVAL
// ============================================================================
class Interval {
  constructor(start, end) {
    if (!(start instanceof DateTime) || !(end instanceof DateTime)) {
      throw new Error('Interval requires DateTime start and end');
    }
    if (start.toMillis() > end.toMillis()) {
      throw new Error('Interval start must be <= end');
    }
    this.start = start;
    this.end = end;
    Object.freeze(this);
  }

  static fromDateTimes(start, end) {
    return new Interval(start, end);
  }

  static after(start, dur) {
    const d = dur instanceof Duration ? dur : Duration.fromObject(dur);
    return new Interval(start, start.plus(d));
  }

  static before(end, dur) {
    const d = dur instanceof Duration ? dur : Duration.fromObject(dur);
    return new Interval(end.minus(d), end);
  }

  length() {
    return Duration.fromMillis(this.end.toMillis() - this.start.toMillis());
  }

  contains(dt) {
    const ms = dt instanceof DateTime ? dt.toMillis() : DateTime.fromJSDate(new Date(dt)).toMillis();
    return this.start.toMillis() <= ms && ms <= this.end.toMillis();
  }

  overlaps(other) {
    if (!(other instanceof Interval)) throw new Error('overlaps expects Interval');
    return this.start.toMillis() <= other.end.toMillis() && other.start.toMillis() <= this.end.toMillis();
  }

  merge(other) {
    if (!this.overlaps(other)) throw new Error('Cannot merge non-overlapping intervals');
    const start = this.start.toMillis() < other.start.toMillis() ? this.start : other.start;
    const end = this.end.toMillis() > other.end.toMillis() ? this.end : other.end;
    return new Interval(start, end);
  }
}

// ============================================================================
// INFO
// ============================================================================
/**
 * @typedef {Object} InfoOptions
 * @property {string} [locale]
 */
const Info = {
  /**
   * @param {InfoOptions} [options]
   */
  months({ locale } = {}) {
    const fmt = new Intl.DateTimeFormat(locale || 'en', {
      month: 'long',
      timeZone: 'UTC'
    });
    return Array.from({ length: 12 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2000, i, 1)))
    );
  },

  /**
   * @param {InfoOptions} [options]
   */
  weekdays({ locale } = {}) {
    const fmt = new Intl.DateTimeFormat(locale || 'en', {
      weekday: 'long',
      timeZone: 'UTC'
    });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(Date.UTC(1970, 0, 4 + i)))
    );
  },

  timeZones() {
    return [Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'];
  }
};


// ------------------------------------------------------------
// Collection Class (Safe Array Extension)
// ------------------------------------------------------------
class Collection extends Array {
  constructor(items = []) {
    super(...(Array.isArray(items) ? items : [items]));
  }

  // -------------------------
  // Meta
  // -------------------------
  count() { return this.length; }
  isEmpty() { return this.length === 0; }
  isNotEmpty() { return this.length > 0; }
  first() { return this[0] ?? null; }
  last() { return this[this.length - 1] ?? null; }
  nth(index) { return this[index] ?? null; }

  // -------------------------
  // Conversion
  // -------------------------
  toArray() { return [...this]; }
  toJSON() { return this.toArray(); }
  clone() { return new Collection(this); }

  // -------------------------
  // Iteration
  // -------------------------
  async each(fn) {
    for (let i = 0; i < this.length; i++) {
      await fn(this[i], i);
    }
    return this;
  }

  async mapAsync(fn) {
    const out = [];
    for (let i = 0; i < this.length; i++) {
      out.push(await fn(this[i], i));
    }
    return new Collection(out);
  }

  // -------------------------
  // Filtering
  // -------------------------
  where(key, value) {
    return new Collection(this.filter(item => item?.[key] === value));
  }

  whereNot(key, value) {
    return new Collection(this.filter(item => item?.[key] !== value));
  }

  filterNull() {
    return new Collection(this.filter(v => v !== null && v !== undefined));
  }

  onlyKeys(keys) {
    return new Collection(this.map(item => {
      const o = {};
      keys.forEach(k => { if (k in item) o[k] = item[k]; });
      return o;
    }));
  }

  exceptKeys(keys) {
    return new Collection(this.map(item => {
      const o = { ...item };
      keys.forEach(k => delete o[k]);
      return o;
    }));
  }

  // -------------------------
  // Sorting
  // -------------------------
  sortBy(key) {
    return new Collection([...this].sort((a, b) =>
      a?.[key] > b?.[key] ? 1 : -1
    ));
  }

  sortByDesc(key) {
    return new Collection([...this].sort((a, b) =>
      a?.[key] < b?.[key] ? 1 : -1
    ));
  }

  // -------------------------
  // Mapping & Transform
  // -------------------------
  mapToArray(fn) {
    return super.map(fn);
  }

  pluck(key) {
    return new Collection(this.map(item => item?.[key]));
  }

  compact() {
    return new Collection(this.filter(Boolean));
  }

  flatten(depth = 1) {
    return new Collection(this.flat(depth));
  }

  flattenDeep() {
    return new Collection(this.flat(Infinity));
  }

  unique(fnOrKey = null) {
    if (typeof fnOrKey === 'string') {
      const seen = new Set();
      return new Collection(this.filter(item => {
        const val = item?.[fnOrKey];
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      }));
    }
    if (typeof fnOrKey === 'function') {
      const seen = new Set();
      return new Collection(this.filter(item => {
        const val = fnOrKey(item);
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      }));
    }
    return new Collection([...new Set(this)]);
  }

  // -------------------------
  // Reducing & Aggregates
  // -------------------------
  sum(key = null) {
    return this.reduce((acc, val) => acc + (key ? val[key] : val), 0);
  }

  avg(key = null) {
    return this.length ? this.sum(key) / this.length : 0;
  }

  max(key = null) {
    if (this.isEmpty()) return null;
    return key
      ? this.reduce((a, b) => (b[key] > a[key] ? b : a))
      : Math.max(...this);
  }

  min(key = null) {
    if (this.isEmpty()) return null;
    return key
      ? this.reduce((a, b) => (b[key] < a[key] ? b : a))
      : Math.min(...this);
  }

  // -------------------------
  // Grouping
  // -------------------------
  groupBy(keyOrFn) {
    const fn = typeof keyOrFn === 'function' ? keyOrFn : (item) => item?.[keyOrFn];
    const groups = {};
    for (const item of this) {
      const group = fn(item);
      if (!groups[group]) groups[group] = new Collection();
      groups[group].push(item);
    }
    return groups; // object of collections
  }

  // -------------------------
  // Selecting random items
  // -------------------------
  random(n = 1) {
    if (n === 1) {
      return this[Math.floor(Math.random() * this.length)] ?? null;
    }
    return new Collection(
      [...this].sort(() => Math.random() - 0.5).slice(0, n)
    );
  }

  shuffle() {
    return new Collection([...this].sort(() => Math.random() - 0.5));
  }

  // -------------------------
  // Chunking
  // -------------------------
  chunk(size) {
    const out = new Collection();
    for (let i = 0; i < this.length; i += size) {
      out.push(new Collection(this.slice(i, i + size)));
    }
    return out;
  }

  // -------------------------
  // Pagination helpers
  // -------------------------
  take(n) {
    return new Collection(this.slice(0, n));
  }

  skip(n) {
    return new Collection(this.slice(n));
  }

  // -------------------------
  // Find / Search
  // -------------------------
  find(fn) {
    return this.filter(fn)[0] ?? null;
  }

  includesWhere(key, value) {
    return this.some(item => item?.[key] === value);
  }

  has(fn) {
    return this.some(fn);
  }

  // -------------------------
  // Set operations
  // -------------------------
  intersect(otherCollection) {
    return new Collection(this.filter(i => otherCollection.includes(i)));
  }

  diff(otherCollection) {
    return new Collection(this.filter(i => !otherCollection.includes(i)));
  }

  union(otherCollection) {
    return new Collection([...new Set([...this, ...otherCollection])]);
  }

  // -------------------------
  // Pipe (functional style)
  // -------------------------
  pipe(fn) {
    return fn(this);
  }

  // -------------------------
  // Static helpers
  // -------------------------
  static make(items = []) {
    return new Collection(items);
  }

  static range(start, end) {
    const arr = [];
    for (let i = start; i <= end; i++) arr.push(i);
    return new Collection(arr);
  }
}


/******************************************************************************
 * QueryBuilder (Bug-Free)
 *****************************************************************************/
class QueryBuilder {
  constructor(table, modelClass = null) {
    this.table = table;
    this.tableAlias = null;
    this.modelClass = modelClass;

    this._select = ['*'];
    this._joins = [];
    this._wheres = [];
    this._group = [];
    this._having = [];
    this._orders = [];
    this._limit = null;
    this._offset = null;
    this._forUpdate = false;
    this._distinct = false;

    this._with = [];
    this._ignoreSoftDeletes = false;

    this._ctes = [];
    this._unions = [];
    this._fromRaw = null;
  }

  /**************************************************************************
   * BASIC CONFIG
   **************************************************************************/
  alias(a) { this.tableAlias = a; return this; }
  distinct() { this._distinct = true; return this; }

  /**************************************************************************
   * SELECT
   **************************************************************************/
  select(...cols) {
    if (!cols.length) return this;

    const flat = cols.flat();
    const normalized = flat.flatMap(col => {
      if (typeof col === 'object' && !Array.isArray(col)) {
        return Object.entries(col).map(([k, v]) =>
          `${escapeId(k)} AS ${escapeId(v)}`
        );
      }
      return col;
    });

    this._select = normalized;
    return this;
  }

  addSelect(...cols) {
    this._select.push(...cols.flat());
    return this;
  }

  /**************************************************************************
   * JOINS
   **************************************************************************/
  join(type, table, first, operator, second) {
    this._joins.push({
      type: type.toUpperCase(),
      table,
      first,
      operator,
      second
    });
    return this;
  }

  innerJoin(t, f, o, s) { return this.join('INNER', t, f, o, s); }
  leftJoin(t, f, o, s) { return this.join('LEFT', t, f, o, s); }
  rightJoin(t, f, o, s) { return this.join('RIGHT', t, f, o, s); }
  crossJoin(t) { return this.join('CROSS', t, null, null, null); }

  /**************************************************************************
   * WHERE HELPERS
   **************************************************************************/
  _pushWhere(w) {
    if (!this._wheres) this._wheres = [];

    if (w.boolean == null) w.boolean = "AND";
    if (w.bindings === undefined) w.bindings = [];

    this._wheres.push(w);
    return this;
  }

  then(resolve, reject) {
    return this.get().then(resolve, reject);
  }

  where(columnOrObject, operator, value) {

    // object-form where({a:1, b:2})
    if (typeof columnOrObject === "object" && columnOrObject !== null) {
      let query = this;
      for (const [col, val] of Object.entries(columnOrObject)) {
        query = query.where(col, val); 
      }
      return query;
    }

    // 2 arguments: where(col, value)
    if (arguments.length === 2) {
      return this._pushWhere({
        type: 'basic',
        column: columnOrObject,
        operator: '=',
        value: operator,
        bindings: [operator]
      });
    }

    // 3 arguments
    return this._pushWhere({
      type: 'basic',
      column: columnOrObject,
      operator,
      value,
      bindings: [value]
    });
  }

  orWhere(columnOrObject, operatorOrValue, value) {

    // object-form: orWhere({ a:1, b:2 })
    if (typeof columnOrObject === "object" && columnOrObject !== null) {
      let query = this;
      for (const [col, val] of Object.entries(columnOrObject)) {
        query = query.orWhere(col, val);
      }
      return query;
    }

    // 2-arguments form: orWhere(col, value)
    if (arguments.length === 2) {
      return this._pushWhere({
        type: 'basic',
        boolean: 'OR',
        column: columnOrObject,
        operator: '=',
        value: operatorOrValue,
        bindings: [operatorOrValue]
      });
    }

    // 3-arguments form
    return this._pushWhere({
      type: 'basic',
      boolean: 'OR',
      column: columnOrObject,
      operator: operatorOrValue,
      value,
      bindings: [value]
    });
  }

  whereRaw(sql, bindings = []) {
    return this._pushWhere({
      type: 'raw',
      raw: sql,
      bindings: Array.isArray(bindings) ? bindings : [bindings]
    });
  }

  orWhereRaw(sql, bindings = []) {
    return this._pushWhere({
      type: 'raw',
      boolean: 'OR',
      raw: sql,
      bindings: Array.isArray(bindings) ? bindings : [bindings]
    });
  }

  whereColumn(a, op, b) {
    if (arguments.length === 2) { b = op; op = '='; }
    return this._pushWhere({
      type: 'columns',
      first: a,
      operator: op,
      second: b
    });
  }

  orWhereColumn(a, op, b) {
    if (arguments.length === 2) { b = op; op = '='; }
    return this._pushWhere({
      type: 'columns',
      boolean: 'OR',
      first: a,
      operator: op,
      second: b
    });
  }

  whereNested(cb) {
    const qb = new QueryBuilder(this.table, this.modelClass);
    cb(qb);

    return this._pushWhere({
      type: 'nested',
      query: qb,
      bindings: qb._gatherBindings()
    });
  }

  whereIn(column, values = []) {
    if (!Array.isArray(values)) throw new Error('whereIn expects array');
    if (!values.length) {
      return this._pushWhere({ type: 'raw', raw: '0 = 1', bindings: [] });
    }

    return this._pushWhere({
      type: 'in',
      column,
      values,
      bindings: [...values]
    });
  }

  /** COMPLETELY FIXED VERSION */
  whereNot(column, operatorOrValue, value) {
    if (typeof column === 'object' && column !== null) {
      for (const [k, v] of Object.entries(column))
        this.whereNot(k, v);
      return this;
    }

    let operator = '=';
    let val = operatorOrValue;

    if (arguments.length === 3) {
      operator = operatorOrValue;
      val = value;
    }

    if (operator === '=') operator = '!=';
    if (operator.toUpperCase() === 'IN') operator = 'NOT IN';

    return this._pushWhere({
      type: 'basic',
      not: true,
      column,
      operator,
      value: val,
      bindings: [val]
    });
  }

  whereNotIn(column, values = []) {
    if (!Array.isArray(values)) throw new Error('whereNotIn expects array');
    if (!values.length) {
      return this._pushWhere({ type: 'raw', raw: '1 = 1', bindings: [] });
    }

    return this._pushWhere({
      type: 'notIn',
      column,
      values,
      bindings: [...values]
    });
  }

  whereNull(col) {
    return this._pushWhere({ type: 'null', column: col, not: false });
  }

  whereNotNull(col) {
    return this._pushWhere({ type: 'null', column: col, not: true });
  }

  whereBetween(col, [a, b]) {
    return this._pushWhere({
      type: 'between',
      column: col,
      bounds: [a, b],
      not: false,
      bindings: [a, b]
    });
  }

  whereNotBetween(col, [a, b]) {
    return this._pushWhere({
      type: 'between',
      column: col,
      bounds: [a, b],
      not: true,
      bindings: [a, b]
    });
  }

  whereExists(builderOrRaw) {
    return this._existsHelper(builderOrRaw, false);
  }

  whereNotExists(builderOrRaw) {
    return this._existsHelper(builderOrRaw, true);
  }

  _existsHelper(builderOrRaw, neg) {
    if (typeof builderOrRaw === 'function') {
      const qb = new QueryBuilder(this.table, this.modelClass);
      builderOrRaw(qb);

      return this._pushWhere({
        type: neg ? 'notExists' : 'exists',
        query: qb,
        bindings: qb._gatherBindings()
      });
    }

    if (builderOrRaw instanceof QueryBuilder) {
      return this._pushWhere({
        type: neg ? 'notExists' : 'exists',
        query: builderOrRaw,
        bindings: builderOrRaw._gatherBindings()
      });
    }

    return this._pushWhere({
      type: neg ? 'rawNotExists' : 'rawExists',
      raw: builderOrRaw
    });
  }

  /**************************************************************************
   * JSON
   **************************************************************************/
  whereJsonPath(column, path, operator, value) {
    if (arguments.length === 3) { value = operator; operator = '='; }

    return this._pushWhere({
      type: 'raw',
      raw: `JSON_EXTRACT(${escapeId(column)}, '${path}') ${operator} ?`,
      bindings: [value]
    });
  }

  whereJsonContains(column, value) {
    return this._pushWhere({
      type: 'raw',
      raw: `JSON_CONTAINS(${escapeId(column)}, ?)`,
      bindings: [JSON.stringify(value)]
    });
  }

  /**************************************************************************
   * GROUP / HAVING
   **************************************************************************/
  groupBy(...cols) {
    this._group.push(...cols.flat());
    return this;
  }

  having(column, operatorOrValue, value) {
    if (arguments.length === 2) {
      return this._pushHaving(column, '=', operatorOrValue, 'AND');
    }
    return this._pushHaving(column, operatorOrValue, value, 'AND');
  }

  orHaving(column, operatorOrValue, value) {
    if (arguments.length === 2) {
      return this._pushHaving(column, '=', operatorOrValue, 'OR');
    }
    return this._pushHaving(column, operatorOrValue, value, 'OR');
  }

  _pushHaving(column, op, value, bool) {
    this._having.push({
      column,
      operator: op,
      value,
      boolean: bool,
      bindings: [value]
    });
    return this;
  }

  /**************************************************************************
   * ORDER / LIMIT
   **************************************************************************/
  orderBy(col, dir = 'ASC') {
    this._orders.push([col, dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC']);
    return this;
  }

  limit(n) { this._limit = Number(n); return this; }
  offset(n) { this._offset = Number(n); return this; }
  forUpdate() { this._forUpdate = true; return this; }

  /**************************************************************************
   * CTE
   **************************************************************************/
  withCTE(name, query, { recursive = false } = {}) {
    this._ctes.push({ name, query, recursive });
    return this;
  }

  /**************************************************************************
   * UNION
   **************************************************************************/
  union(q) { this._unions.push({ type: 'UNION', query: q }); return this; }
  unionAll(q) { this._unions.push({ type: 'UNION ALL', query: q }); return this; }

  /**************************************************************************
   * RAW FROM
   **************************************************************************/
  fromRaw(raw) { this._fromRaw = raw; return this; }

  /**************************************************************************
   * WITH (Eager Load)
   **************************************************************************/
  with(relations) {
    if (!Array.isArray(relations)) relations = [relations];

    for (const r of relations) {
      if (!this._with.includes(r)) this._with.push(r);
    }

    return this;
  }

  ignoreSoftDeletes() {
    this._ignoreSoftDeletes = true;
    return this;
  }

  /**************************************************************************
   * COMPILERS
   **************************************************************************/
  _compileSelect() {
    const parts = [];

    /* CTEs */
    if (this._ctes.length) {
      const rec = this._ctes.some(x => x.recursive)
        ? 'WITH RECURSIVE '
        : 'WITH ';

      const cteSql = this._ctes
        .map(cte => {
          const q =
            cte.query instanceof QueryBuilder
              ? `(${cte.query._compileSelect()})`
              : `(${cte.query})`;
          return `${escapeId(cte.name)} AS ${q}`;
        })
        .join(', ');

      parts.push(rec + cteSql);
    }

    parts.push('SELECT');
    if (this._distinct) parts.push('DISTINCT');

    parts.push(this._select.length ? this._select.join(', ') : '*');

    if (this._fromRaw) {
      parts.push('FROM ' + this._fromRaw);
    } else {
      parts.push(
        'FROM ' +
        escapeId(this.table) +
        (this.tableAlias ? ' AS ' + escapeId(this.tableAlias) : '')
      );
    }

    /* JOINS */
    for (const j of this._joins) {
      if (j.type === 'CROSS') {
        parts.push(`CROSS JOIN ${escapeId(j.table)}`);
      } else {
        parts.push(
          `${j.type} JOIN ${escapeId(j.table)} ON ${escapeId(j.first)} ${j.operator} ${escapeId(j.second)}`
        );
      }
    }

    /* WHERE */
    const whereSql = this._compileWheres();
    if (whereSql) parts.push(whereSql);

    /* GROUP */
    if (this._group.length) {
      parts.push('GROUP BY ' + this._group.map(escapeId).join(', '));
    }

    /* HAVING */
    if (this._having.length) {
      const has = this._having
        .map((h, i) => {
          const pre = i === 0 ? 'HAVING ' : `${h.boolean} `;
          return pre + `${escapeId(h.column)} ${h.operator} ?`;
        })
        .join(' ');
      parts.push(has);
    }

    /* ORDER */
    if (this._orders.length) {
      parts.push(
        'ORDER BY ' +
        this._orders
          .map(([c, d]) => `${escapeId(c)} ${d}`)
          .join(', ')
      );
    }

    /* LIMIT / OFFSET */
    if (this._limit != null) parts.push(`LIMIT ${this._limit}`);
    if (this._offset != null) parts.push(`OFFSET ${this._offset}`);

    if (this._forUpdate) parts.push('FOR UPDATE');

    let sql = parts.join(' ');

    /* UNION */
    if (this._unions.length) {
      for (const u of this._unions) {
        const other =
          u.query instanceof QueryBuilder
            ? u.query._compileSelect()
            : u.query;
        sql = `(${sql}) ${u.type} (${other})`;
      }
    }

    return sql;
  }

  _compileWheres() {
    if (!this._wheres.length) return '';

    const out = [];

    this._wheres.forEach((w, i) => {
      const pre = i === 0 ? 'WHERE ' : w.boolean + ' ';

      switch (w.type) {
        case 'raw':
          out.push(pre + w.raw);
          break;

        case 'basic':
          out.push(pre + `${escapeId(w.column)} ${w.operator} ?`);
          break;

        case 'columns':
          out.push(pre + `${escapeId(w.first)} ${w.operator} ${escapeId(w.second)}`);
          break;

        case 'nested': {
          const inner = w.query._compileWheres().replace(/^WHERE\s*/i, '');
          out.push(pre + `(${inner})`);
          break;
        }

        case 'in':
          out.push(
            pre + `${escapeId(w.column)} IN (${w.values.map(() => '?').join(', ')})`
          );
          break;

        case 'notIn':
          out.push(
            pre + `${escapeId(w.column)} NOT IN (${w.values.map(() => '?').join(', ')})`
          );
          break;

        case 'null':
          out.push(
            pre + `${escapeId(w.column)} IS ${w.not ? 'NOT ' : ''}NULL`
          );
          break;

        case 'between':
          out.push(
            pre +
            `${escapeId(w.column)} ${w.not ? 'NOT BETWEEN' : 'BETWEEN'} ? AND ?`
          );
          break;

        case 'exists':
          out.push(pre + `EXISTS (${w.query._compileSelect()})`);
          break;

        case 'notExists':
          out.push(pre + `NOT EXISTS (${w.query._compileSelect()})`);
          break;

        case 'rawExists':
          out.push(pre + `EXISTS (${w.raw})`);
          break;

        case 'rawNotExists':
          out.push(pre + `NOT EXISTS (${w.raw})`);
          break;

        default:
          throw new Error('Unknown where type: ' + w.type);
      }
    });

    return out.join(' ');
  }

  _gatherBindings() {
    const out = [];

    for (const c of this._ctes) {
      if (c.query instanceof QueryBuilder)
        out.push(...c.query._gatherBindings());
    }

    for (const w of this._wheres) {
      if (w.bindings?.length) out.push(...w.bindings);
    }

    for (const h of this._having) {
      if (h.bindings?.length) out.push(...h.bindings);
    }

    for (const u of this._unions) {
      if (u.query instanceof QueryBuilder)
        out.push(...u.query._gatherBindings());
    }

    return out;
  }

  /**************************************************************************
   * READ METHODS
   **************************************************************************/
  async get() {
    const sql = this._compileSelect();
    const binds = this._gatherBindings();

    DB.log(sql, binds);
    const rows = await DB.raw(sql, binds);

    if (this.modelClass) {
      const models = rows.map(r => new this.modelClass(r, true));

      if (this._with.length) {
        const loaded = await this._eagerLoad(models);
        return new Collection(loaded);
      }

      return new Collection(models);
    }

    return new Collection(rows);
  }

  async first() {
    const c = this._clone();
    c.limit(1);

    const rows = await c.get();
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async firstOrFail() {
    const r = await this.first();
    if (!r) throw new Error('Record not found');
    return r;
  }

  async exists() {
    const c = this._clone();
    c._select = ['1'];
    c._orders = [];
    c.limit(1);

    const sql = c._compileSelect();
    const b = c._gatherBindings();

    DB.log(sql, b);
    const rows = await DB.raw(sql, b);
    return rows.length > 0;
  }

  async doesntExist() {
    return !(await this.exists());
  }

  async count(column = '*') {
    const c = this._clone();
    c._select = [`COUNT(${column}) AS aggregate`];
    c._orders = [];
    c._limit = null;
    c._offset = null;

    const sql = c._compileSelect();
    const b = c._gatherBindings();

    DB.log(sql, b);
    const rows = await DB.raw(sql, b);

    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  async _aggregate(expr) {
    const c = this._clone();
    c._select = [`${expr} AS aggregate`];
    c._orders = [];
    c._limit = null;
    c._offset = null;

    const sql = c._compileSelect();
    const b = c._gatherBindings();

    DB.log(sql, b);
    const rows = await DB.raw(sql, b);

    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  sum(c) { return this._aggregate(`SUM(${escapeId(c)})`); }
  avg(c) { return this._aggregate(`AVG(${escapeId(c)})`); }
  min(c) { return this._aggregate(`MIN(${escapeId(c)})`); }
  max(c) { return this._aggregate(`MAX(${escapeId(c)})`); }
  countDistinct(c) { return this._aggregate(`COUNT(DISTINCT ${escapeId(c)})`); }

  async pluck(col) {
    const c = this._clone();
    c._select = [escapeId(col)];

    const sql = c._compileSelect();
    const b = c._gatherBindings();

    DB.log(sql, b);
    const rows = await DB.raw(sql, b);

    return rows.map(r => r[col]);
  }

  async paginate(page = 1, perPage = 15) {
    page = Math.max(1, Number(page));
    perPage = Math.max(1, Number(perPage));

    const total = await this.count('*');
    const offset = (page - 1) * perPage;

    this.limit(perPage).offset(offset);
    const data = await this.get();

    return {
      total,
      perPage,
      page,
      lastPage: Math.ceil(total / perPage),
      data
    };
  }

  /**************************************************************************
   * WRITE METHODS
   **************************************************************************/
  async insert(values) {
    const keys = Object.keys(values);
    const placeholders = keys.map(() => '?').join(', ');
    const sql =
      `INSERT INTO ${escapeId(this.table)} (` +
      keys.map(escapeId).join(', ') +
      `) VALUES (${placeholders})`;

    const bindings = Object.values(values);
    DB.log(sql, bindings);
    const result = await DB.raw(sql, bindings);

    return result.affectedRows || 0;
  }

  async insertGetId(values) {
    const keys = Object.keys(values);
    const placeholders = keys.map(() => '?').join(', ');
    const sql =
      `INSERT INTO ${escapeId(this.table)} (` +
      keys.map(escapeId).join(', ') +
      `) VALUES (${placeholders})`;

    const bindings = Object.values(values);
    DB.log(sql, bindings);
    const result = await DB.raw(sql, bindings);

    return result.insertId ?? null;
  }

  async update(values) {
    if (!Object.keys(values).length) return 0;

    const setClause = Object.keys(values)
      .map(k => `${escapeId(k)} = ?`)
      .join(', ');

    const whereSql = this._compileWhereOnly();
    const sql =
      `UPDATE ${escapeId(this.table)} SET ${setClause} ${whereSql}`;

    const bindings = [...Object.values(values), ...this._gatherBindings()];

    DB.log(sql, bindings);
    const result = await DB.raw(sql, bindings);

    return result.affectedRows || 0;
  }

  async increment(col, by = 1) {
    const sql =
      `UPDATE ${escapeId(this.table)} ` +
      `SET ${escapeId(col)} = ${escapeId(col)} + ? ` +
      this._compileWhereOnly();

    const b = [by, ...this._gatherBindings()];
    DB.log(sql, b);
    const res = await DB.raw(sql, b);

    return res.affectedRows || 0;
  }

  async decrement(col, by = 1) {
    const sql =
      `UPDATE ${escapeId(this.table)} ` +
      `SET ${escapeId(col)} = ${escapeId(col)} - ? ` +
      this._compileWhereOnly();

    const b = [by, ...this._gatherBindings()];
    DB.log(sql, b);
    const res = await DB.raw(sql, b);

    return res.affectedRows || 0;
  }

  async delete() {
    const sql =
      `DELETE FROM ${escapeId(this.table)} ` +
      this._compileWhereOnly();

    const b = this._gatherBindings();
    DB.log(sql, b);

    const res = await DB.raw(sql, b);
    return res.affectedRows || 0;
  }

  async truncate() {
    const sql = `TRUNCATE TABLE ${escapeId(this.table)}`;
    DB.log(sql, []);
    await DB.raw(sql);
    return true;
  }

  _compileWhereOnly() {
    const w = this._compileWheres();
    return w ? w : '';
  }

  /**************************************************************************
   * EAGER LOAD (unchanged except robust checks)
   **************************************************************************/
  async _eagerLoad(models) {
    for (const relName of this._with) {
      const sample = models[0];
      if (!sample) return models;

      const relationMethod = sample[relName];
      if (typeof relationMethod !== 'function') {
        throw new Error(`Relation "${relName}" is not a method on ${sample.constructor.name}`);
      }

      const relation = relationMethod.call(sample);

      if (!relation || typeof relation.eagerLoad !== 'function') {
        throw new Error(`Relation "${relName}" does not have a valid eagerLoad method`);
      }

      await relation.eagerLoad(models, relName);
    }

    return models;
  }

  /**************************************************************************
   * CLONE
   **************************************************************************/
  _clone() {
    const c = new QueryBuilder(this.table, this.modelClass);

    c.tableAlias = this.tableAlias;
    c._select = [...this._select];
    c._joins = JSON.parse(JSON.stringify(this._joins));
    c._group = [...this._group];
    c._orders = [...this._orders];
    c._limit = this._limit;
    c._offset = this._offset;
    c._forUpdate = this._forUpdate;
    c._distinct = this._distinct;
    c._with = [...this._with];
    c._ignoreSoftDeletes = this._ignoreSoftDeletes;
    c._fromRaw = this._fromRaw;

    // rehydrate nested queries
    c._wheres = this._rehydrateWheres(this._wheres);

    // rehydrate CTEs
    c._ctes = this._rehydrateCTEs(this._ctes);

    // rehydrate unions
    c._unions = this._rehydrateUnions(this._unions);

    // having is simple
    c._having = JSON.parse(JSON.stringify(this._having));

    return c;
  }

  _rehydrateWheres(ws) {
    return ws.map(w => {
      if (w.type === 'nested' && w.query) {
        const qb = new QueryBuilder(this.table, this.modelClass);
        qb._wheres = this._rehydrateWheres(w.query._wheres);
        qb._joins = w.query._joins ? [...w.query._joins] : [];
        qb._group = w.query._group ? [...w.query._group] : [];
        qb._having = w.query._having ? [...w.query._having] : [];
        qb._orders = w.query._orders ? [...w.query._orders] : [];
        qb._limit = w.query._limit;
        qb._offset = w.query._offset;
        qb._forUpdate = w.query._forUpdate;
        qb._select = [...w.query._select];

        return {
          ...w,
          query: qb,
          bindings: qb._gatherBindings()
        };
      }

      if ((w.type === 'exists' || w.type === 'notExists') && w.query) {
        const qb = new QueryBuilder(w.query.table, w.query.modelClass);
        qb._wheres = this._rehydrateWheres(w.query._wheres);
        qb._select = [...w.query._select];
        return {
          ...w,
          query: qb,
          bindings: qb._gatherBindings()
        };
      }

      return JSON.parse(JSON.stringify(w));
    });
  }

  _rehydrateCTEs(ctes) {
    return ctes.map(cte => {
      if (cte.query instanceof QueryBuilder) {
        const qb = new QueryBuilder(cte.query.table, cte.query.modelClass);
        qb._wheres = this._rehydrateWheres(cte.query._wheres);
        qb._select = [...cte.query._select];
        return {
          ...cte,
          query: qb
        };
      }
      return { ...cte };
    });
  }

  _rehydrateUnions(unions) {
    return unions.map(u => {
      if (u.query instanceof QueryBuilder) {
        const qb = new QueryBuilder(u.query.table, u.query.modelClass);
        qb._wheres = this._rehydrateWheres(u.query._wheres);
        qb._select = [...u.query._select];
        return {
          ...u,
          query: qb
        };
      }
      return { ...u };
    });
  }

  /**************************************************************************
   * TO SQL
   **************************************************************************/
  toSQL() {
    return {
      sql: this._compileSelect(),
      bindings: this._gatherBindings()
    };
  }

  toSQLWhereOnly() {
    return {
      sql: this._compileWhereOnly(),
      bindings: this._gatherBindings()
    };
  }
}

// --- Relations ---
class Relation {
  constructor(parent, relatedClass, foreignKey = null, localKey = null) {
    this.parent = parent;
    this.relatedClass = relatedClass;
    this.foreignKey = foreignKey;
    this.localKey = localKey || (parent.constructor.primaryKey || "id");
    this.deleteBehavior = null;
  }

  onDelete(behavior) {
    this.deleteBehavior = behavior;
    return this;
  }
}


class BelongsTo extends Relation {
  constructor(parent, relatedClass, foreignKey = null, ownerKey = null) {
    super(parent, relatedClass, foreignKey, ownerKey || relatedClass.primaryKey || "id");

    this.foreignKey = foreignKey || `${relatedClass.table.replace(/s$/, "")}_id`;
    this.ownerKey = ownerKey || relatedClass.primaryKey || "id";
  }

  async get() {
    const fkValue = this.parent[this.foreignKey];
    return await this.relatedClass.query().where(this.ownerKey, fkValue).first();
  }

  async eagerLoad(parents, relName) {
    const fkValues = parents.map(p => p[this.foreignKey]).filter(Boolean);

    const relatedRows = await this.relatedClass
      .query()
      .whereIn(this.ownerKey, fkValues)
      .get();

    const map = new Map();
    relatedRows.forEach(r => map.set(r[this.ownerKey], r));

    parents.forEach(parent => {
      parent[relName] = map.get(parent[this.foreignKey]) || null;
    });
  }
}


/* ---------------- HasOne ---------------- */
class HasOne extends Relation {
  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .first();
  }

  async eagerLoad(parents, relName) {
    const parentIds = parents.map(p => p[this.localKey]);

    const relatedRows = await this.relatedClass
      .query()
      .whereIn(this.foreignKey, parentIds)
      .get();

    const grouped = new Map();
    parents.forEach(p => grouped.set(p[this.localKey], null));

    relatedRows.forEach(r => grouped.set(r[this.foreignKey], r));

    parents.forEach(p => {
      p[relName] = grouped.get(p[this.localKey]) || null;
    });
  }
}


/* ---------------- BelongsTo ---------------- */
class HasMany extends Relation {
  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .get();
  }

  async eagerLoad(parents, relName) {
    const parentIds = parents.map(p => p[this.localKey]);

    const rows = await this.relatedClass
      .query()
      .whereIn(this.foreignKey, parentIds)
      .get();

    const grouped = new Map();
    parents.forEach(p => grouped.set(p[this.localKey], []));

    rows.forEach(r => grouped.get(r[this.foreignKey]).push(r));

    parents.forEach(p => {
      p[relName] = grouped.get(p[this.localKey]);
    });
  }
}

class HasManyThrough extends Relation {
  constructor(parent, relatedClass, throughClass, firstKey, secondKey, localKey, secondLocalKey) {
    super(parent, relatedClass, firstKey, localKey);
    this.throughClass = throughClass;
    this.firstKey = firstKey || parent.constructor.primaryKey || "id";
    this.secondKey = secondKey || `${throughClass.table.replace(/s$/, "")}_id`;
    this.localKey = localKey || (parent.constructor.primaryKey || "id");
    this.secondLocalKey = secondLocalKey || relatedClass.primaryKey || "id";
  }

  async get() {
    const throughRows = await this.throughClass
      .query()
      .where(this.firstKey, this.parent[this.localKey])
      .get();

    const throughIds = throughRows.map(r => r[this.secondKey]);

    return await this.relatedClass
      .query()
      .whereIn(this.secondLocalKey, throughIds)
      .get();
  }
}

class MorphOne extends Relation {
  constructor(parent, relatedClass, morphName, localKey = null) {
    super(parent, relatedClass, `${morphName}_id`, localKey);
    this.morphType = `${morphName}_type`;
  }

  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .where(this.morphType, this.parent.constructor.name)
      .first();
  }
}

class MorphMany extends Relation {
  constructor(parent, relatedClass, morphName, localKey = null) {
    super(parent, relatedClass, `${morphName}_id`, localKey);
    this.morphType = `${morphName}_type`;
  }

  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .where(this.morphType, this.parent.constructor.name)
      .get();
  }
}

class MorphTo {
  constructor(parent, typeField = "morph_type", idField = "morph_id") {
    this.parent = parent;
    this.typeField = typeField;
    this.idField = idField;
  }

  async get() {
    const klass = globalThis[this.parent[this.typeField]];
    const id = this.parent[this.idField];
    return await klass.find(id);
  }
}

class MorphToMany extends Relation {
  constructor(parent, relatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    const morphId = `${morphName}_id`;
    const morphType = `${morphName}_type`;

    super(parent, relatedClass, morphId, parent.constructor.primaryKey);

    this.morphTypeColumn = morphType;

    this.pivotTable =
      pivotTable || `${morphName}_${relatedClass.table}`;

    this.foreignKey = foreignKey || morphId;
    this.relatedKey = relatedKey || `${relatedClass.table.replace(/s$/, "")}_id`;
  }
}

class MorphedByMany extends MorphToMany {
  constructor(parent, relatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    super(parent, relatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }
}


/* ---------------- BelongsToMany ---------------- */

class BelongsToMany extends Relation {
  constructor(parent, relatedClass, pivotTable = null, foreignKey = null, relatedKey = null) {
    const parentTable = parent.constructor.table;
    const relatedTable = relatedClass.table;

    const parentPK = parent.constructor.primaryKey || "id";
    const relatedPK = relatedClass.primaryKey || "id";

    if (!pivotTable) {
      const sorted = [parentTable, relatedTable].sort();
      pivotTable = sorted.join("_");
    }

    if (!foreignKey) foreignKey = `${parentTable.replace(/s$/, "")}_id`;
    if (!relatedKey) relatedKey = `${relatedTable.replace(/s$/, "")}_id`;

    super(parent, relatedClass, foreignKey, parentPK);

    this.pivotTable = pivotTable;
    this.relatedKey = relatedKey;

    this.parentPK = parentPK;
    this.relatedPK = relatedPK;

    // Optional pivot options
    this._pivotColumns = [];
    this._withTimestamps = false;
    this._pivotOrder = null;
  }

  // -----------------------------------------------------
  //  CONFIGURATION HELPERS
  // -----------------------------------------------------

  withPivot(...columns) {
    this._pivotColumns.push(...columns);
    return this;
  }

  withTimestamps() {
    this._withTimestamps = true;
    return this;
  }

  orderByPivot(column, direction = "asc") {
    this._pivotOrder = { column, direction };
    return this;
  }

  // -----------------------------------------------------
  //  LAZY LOAD RELATIONSHIP
  // -----------------------------------------------------
  async get() {
    const parentId = this.parent[this.parentPK];

    const pivotCols = [
      `${this.pivotTable}.${this.foreignKey}`,
      `${this.pivotTable}.${this.relatedKey}`,
      ...this._pivotColumns.map(c => `${this.pivotTable}.${c}`)
    ];

    if (this._withTimestamps) {
      pivotCols.push(`${this.pivotTable}.created_at`);
      pivotCols.push(`${this.pivotTable}.updated_at`);
    }

    const query = this.relatedClass
      .query()
      .join(
        this.pivotTable,
        `${this.relatedClass.table}.${this.relatedPK}`,
        "=",
        `${this.pivotTable}.${this.relatedKey}`
      )
      .where(`${this.pivotTable}.${this.foreignKey}`, parentId)
      .select(`${this.relatedClass.table}.*`, ...pivotCols);

    if (this._pivotOrder) {
      query.orderBy(
        `${this.pivotTable}.${this._pivotOrder.column}`,
        this._pivotOrder.direction
      );
    }

    const rows = await query.get();

    return this._hydratePivot(rows);
  }

  // -----------------------------------------------------
  //  EAGER LOADING
  // -----------------------------------------------------
  async eagerLoad(parents, relName) {
    if (!parents.length) {
      parents.forEach(p => (p[relName] = []));
      return;
    }

    const parentIds = parents.map(p => p[this.parentPK]);

    const pivotRows = await new QueryBuilder(this.pivotTable)
      .whereIn(this.foreignKey, parentIds)
      .get();

    if (!pivotRows.length) {
      parents.forEach(p => (p[relName] = []));
      return;
    }

    const relatedIds = pivotRows.map(p => p[this.relatedKey]);

    const relatedRows = await new QueryBuilder(
      this.relatedClass.table,
      this.relatedClass
    )
      .whereIn(this.relatedPK, relatedIds)
      .get();

    const pivotByParent = new Map();
    parents.forEach(p => pivotByParent.set(p[this.parentPK], []));
    pivotRows.forEach(p => pivotByParent.get(p[this.foreignKey]).push(p));

    const relatedById = new Map();
    relatedRows.forEach(r => relatedById.set(r[this.relatedPK], r));

    parents.forEach(parent => {
      const pivots = pivotByParent.get(parent[this.parentPK]) || [];
      parent[relName] = pivots.map(pivot => {
        const related = { ...relatedById.get(pivot[this.relatedKey]) };
        related._pivot = pivot;
        return related;
      });
    });
  }

  // -----------------------------------------------------
  //  MUTATORS (attach, detach, sync, toggle)
  // -----------------------------------------------------

  async attach(ids, pivotData = {}) {
    if (!Array.isArray(ids)) ids = [ids];

    const rows = ids.map(id => {
      const data = {
        [this.foreignKey]: this.parent[this.parentPK],
        [this.relatedKey]: id,
        ...pivotData
      };

      if (this._withTimestamps) {
        data.created_at = new Date();
        data.updated_at = new Date();
      }

      return data;
    });

    return await new QueryBuilder(this.pivotTable).insert(rows);
  }

  async detach(ids = null) {
    const query = new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK]);

    if (ids) {
      if (!Array.isArray(ids)) ids = [ids];
      query.whereIn(this.relatedKey, ids);
    }

    return await query.delete();
  }

  async sync(ids) {
    if (!Array.isArray(ids)) ids = [ids];

    const current = await new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK])
      .get();

    const currentIds = current.map(r => r[this.relatedKey]);

    const toAttach = ids.filter(id => !currentIds.includes(id));
    const toDetach = currentIds.filter(id => !ids.includes(id));

    await this.attach(toAttach);
    await this.detach(toDetach);

    return { attached: toAttach, detached: toDetach };
  }

  async toggle(ids) {
    if (!Array.isArray(ids)) ids = [ids];

    const current = await new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK])
      .get();

    const currentIds = current.map(r => r[this.relatedKey]);

    const toAttach = ids.filter(id => !currentIds.includes(id));
    const toDetach = ids.filter(id => currentIds.includes(id));

    await this.attach(toAttach);
    await this.detach(toDetach);

    return { attached: toAttach, detached: toDetach };
  }

  // -----------------------------------------------------
  //  Internal helper
  // -----------------------------------------------------
  _hydratePivot(rows) {
    return rows.map(row => {
      const model = { ...row };
      model._pivot = {};

      model._pivot[this.foreignKey] = row[this.foreignKey];
      model._pivot[this.relatedKey] = row[this.relatedKey];

      this._pivotColumns.forEach(col => {
        model._pivot[col] = row[col];
      });

      if (this._withTimestamps) {
        model._pivot.created_at = row.created_at;
        model._pivot.updated_at = row.updated_at;
      }

      return model;
    });
  }
}

class ValidationError extends Error {
  /**
   * @param {string | string[] | Record<string, any>} messages - Validation messages
   * @param {ErrorOptions} [options] - Optional error options
   */
  constructor(messages, options = {}) {
    // Convert messages into a human-readable string
    const formattedMessage = ValidationError.formatMessages(messages);

    super(formattedMessage, options);

    // Preserve proper prototype chain
    Object.setPrototypeOf(this, ValidationError.prototype);

    this.name = 'ValidationError';
    this.messages = messages; // raw messages (can be string, array, or object)
    this.status = 422; // HTTP status for Unprocessable Entity
    this.code = 'VALIDATION_ERROR';
  }

  /**
   * Converts messages to a string suitable for web users
   */
  static formatMessages(messages) {
    if (!messages) return 'Validation failed.';
    if (typeof messages === 'string') return messages;
    if (Array.isArray(messages)) return messages.join(', ');
    if (typeof messages === 'object') {
      // Flatten object values and join them
      return Object.values(messages)
        .flat()
        .map(String)
        .join(', ');
    }
    return String(messages);
  }

  // Symbol.toStringTag for TypeScript-like behavior
  get [Symbol.toStringTag]() {
    return 'ValidationError';
  }

  toString() {
    return `${this.name}: ${ValidationError.formatMessages(this.messages)}`;
  }

  // Convenient method to get a user-friendly message
  get errors() {
    return ValidationError.formatMessages(this.messages);
  }
}


// --- The Model class (fixed / cleaned) ---
class Model {
  // class-level defaults
  static table = null;
  static primaryKey = 'id';
  static timestamps = false;
  static fillable = null;
  static tableSingular = null;

  static softDeletes = false;
  static deletedAt = 'deleted_at';
  static hidden = [];
  static visible = null; 
  static rules = {}; // define default validation rules
  static customMessages = {};

  constructor(attributes = {}, fresh = false, data = {}) {
    this._attributes = {};
    this._original = {};
    this._relations = {};
    this._exists = !!fresh;

    // Only store keys with defined values
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) this._attributes[k] = v;
    }

    this._original = { ...this._attributes, ...data };

    // Define getters for attributes
    for (const k of Object.keys(this._attributes)) {
      if (!(k in this)) {
        Object.defineProperty(this, k, {
          get: function() {
            return this._attributes[k];
          },
          enumerable: true
        });
      }
    }
  }

  static async validate(data, id, ignoreId = null) {
    if (!Validator) throw new Error('Validator not found.');

    const rules = this.rules || {};

    // Inject ignoreId into unique rules automatically
    const preparedRules = {};

    for (const field in rules) {
        let r = rules[field];

        if (typeof r === 'string') r = r.split('|');

        // auto attach ignoreId to unique rules
        r = r.map(rule => {
            if (rule.startsWith('unique:') && ignoreId) {
                const [name, table, col] = rule.split(':')[1].split(',');
                return `unique:${table},${col || field},${ignoreId}`;
            }
            return rule;
        });

        preparedRules[field] = r;
    }

    const validator = new Validator(data, id, this.table, preparedRules, this.customMessages, DB);
    const failed = await validator.fails();

    if (failed) {
        throw new ValidationError(validator.getErrors());
    }

    return validator;
  }

  // recommended: length as property
  get length() {
    return Object.keys(this._attributes).length;
  }

  // legacy compatibility: keep a count() method instead of duplicating 'length'
  count() { return this.length; }

  // ──────────────────────────────
  // Core static getters & booting
  // ──────────────────────────────
  static get tableName() {
    if (!this.table) throw new DBError('Model.table must be set for ' + this.name);
    return this.table;
  }

  static boot() {
    if (!this._booted) {
      this._events = { creating: [], updating: [], deleting: [] };
      this._booted = true;
    }
  }

  static on(event, handler) {
    this.boot();
    if (this._events[event]) this._events[event].push(handler);
  }

  // convenience aliases
  static before(event, handler) { return this.on(event, handler); }
  static after(event, handler) { return this.on(event, handler); }

  async trigger(event) {
    const events = this.constructor._events?.[event] || [];
    for (const fn of events) {
      // allow handlers that return promises or sync
      await fn(this);
    }
  }

  // ──────────────────────────────
  // Query builder accessors
  // ──────────────────────────────
  static query({ withTrashed = false } = {}) {
    // use tableName getter (throws if missing)
    const qb = new QueryBuilder(this.tableName, this);
    if (this.softDeletes && !withTrashed) {
      // avoid mutating shared _wheres reference
      qb._wheres = Array.isArray(qb._wheres) ? qb._wheres.slice() : [];
      qb._wheres.push({ raw: `${DB.escapeId(this.deletedAt)} IS NULL` });
    }
    return qb;
  }

  static setTable(table) {
    this.table = table;
  }

  static withTrashed() { return this.query({ withTrashed: true }); }

  // ──────────────────────────────
  // Retrieval methods
  // ──────────────────────────────
  static async all() { return await this.query().get(); }
  static where(...args) { return this.query().where(...args); }
  static whereIn(col, arr) { return this.query().whereIn(col, arr); }
  static whereNot(...args) { return this.query().whereNot(...args); }
  static whereNotIn(col, arr) { return this.query().whereNotIn(col, arr); }
  static whereNull(col) { return this.query().whereNull(col); }

  static async find(id) {
    if (id === undefined || id === null) return null;
    return await this.query().where(this.primaryKey, id).first();
  }
  static async findOrFail(id) {
    const row = await this.find(id);
    if (!row) throw new DBError(`${this.name} not found with ${this.primaryKey} = ${id}`);
    return row;
  }

  static async findBy(col, value) { return await this.query().where(col, value).first(); }
  static async findByOrFail(col, value) {
    const row = await this.findBy(col, value);
    if (!row) throw new DBError(`${this.name} record not found where ${col} = ${value}`);
    return row;
  }

  static async findManyBy(col, values = []) {
    if (!Array.isArray(values)) throw new Error('findManyBy expects an array of values');
    if (!values.length) return [];
    return await this.query().whereIn(col, values).get();
  }

  // additional common accessors
  static async findMany(ids = []) {
    if (!Array.isArray(ids)) ids = [ids];
    if (!ids.length) return [];
    return await this.query().whereIn(this.primaryKey, ids).get();
  }

  // Global .first() support
  static async first(...args) {
    const qb = args.length ? this.where(...args) : this.query();
    return await qb.first();
  }

  static async firstOrFail(...args) {
    const qb = args.length ? this.where(...args) : this.query();
    const row = await qb.first();
    if (!row) throw new DBError(`${this.name} record not found`);
    return row;
  }

  static async firstOrNew(whereAttrs, defaults = {}) {
    const record = await this.query().where(whereAttrs).first();
    if (record) return record;
    return new this({ ...whereAttrs, ...defaults });
  }

  static async firstOrCreate(whereAttrs, defaults = {}) {
    const found = await this.query().where(whereAttrs).first();
    if (found) return found;
    return await this.create({ ...whereAttrs, ...defaults });
  }

  static async updateOrCreate(whereAttrs, values = {}) {
    const query = this.query();

    for (const [col, val] of Object.entries(whereAttrs)) {
      query.where(col, val);
    }

    const found = await query.first();

    if (found) {
      found.fill(values);
      await found.save();
      return found;
    }

    return await this.create({ ...whereAttrs, ...values });
  }

  // ──────────────────────────────
  // CREATE (static)
  // ──────────────────────────────
  static async create(attrs = {}) {
    const clean = {};

    // 1. Remove bad values
    for (const [key, val] of Object.entries(attrs)) {
      if (val !== undefined && !this.isBadValue(val)) {
        clean[key] = val;
      }
    }

    // 2. Enforce fillable whitelist
    const payload = {};
    const fillable = this.fillable || Object.keys(clean);
    for (const key of fillable) {
      if (key in clean) payload[key] = clean[key];
    }

    // 3. Block empty payload
    if (!Object.keys(payload).length) {
      throw new DBError('Attempted to create with empty payload');
    }

    // 4. Create + save
    const model = new this();
    return model.saveNew(payload);
  }

  static async createMany(arr = []) {
    if (!Array.isArray(arr)) throw new DBError('createMany expects an array');
    if (!arr.length) return [];
    const results = [];
    await DB.transaction(async () => {
      for (const attrs of arr) {
        const r = await this.create(attrs);
        results.push(r);
      }
    });
    return results;
  }

  static async fetchOrNewUpMany(list = [], defaults = {}) {
    if (!Array.isArray(list)) throw new DBError('fetchOrNewUpMany expects an array of where objects');
    const out = [];
    for (const whereObj of list) {
      const found = await this.query().where(whereObj).first();
      if (found) out.push(found);
      else out.push(new this({ ...whereObj, ...defaults }));
    }
    return out;
  }

  static async fetchOrCreateMany(list = [], defaults = {}) {
    if (!Array.isArray(list)) throw new DBError('fetchOrCreateMany expects an array of where objects');
    const out = [];
    await DB.transaction(async () => {
      for (const whereObj of list) {
        const found = await this.query().where(whereObj).first();
        if (found) out.push(found);
        else out.push(await this.create({ ...whereObj, ...defaults }));
      }
    });
    return out;
  }

  static async updateOrCreateMany(items = []) {
    if (!Array.isArray(items)) throw new DBError('updateOrCreateMany expects an array');
    const out = [];
    await DB.transaction(async () => {
      for (const it of items) {
        const whereObj = it.where || {};
        const values = it.values || {};
        const found = await this.query().where(whereObj).first();
        if (found) {
          await found.fill(values).save();
          out.push(found);
        } else {
          out.push(await this.create({ ...whereObj, ...values }));
        }
      }
    });
    return out;
  }

  static async truncate() {
    if (DB.driver === 'mysql') {
      await DB.raw(`TRUNCATE TABLE ${this.tableName}`);
    } else if (DB.driver === 'pg') {
      await DB.raw(`TRUNCATE TABLE ${this.tableName} RESTART IDENTITY CASCADE`);
    } else {
      await DB.raw(`DELETE FROM ${this.tableName}`);
      if (DB.driver === 'sqlite') {
        try {
          await DB.raw(`DELETE FROM sqlite_sequence WHERE name = ?`, [this.tableName]);
        } catch (e) { /* ignore */ }
      }
    }
  }

  static async raw(sql, params) { return await DB.raw(sql, params); }

  static async transaction(fn) { return await DB.transaction(fn); }

  // ──────────────────────────────
  // 🛡 SANITIZATION UTIL
  // ──────────────────────────────
  static isBadValue(value) {
    if (value === null || value === undefined || value === '') return true;
    if (typeof value === 'string' && !value.trim()) return true;
    return false;
  }

  sanitize(attrs = {}) {
    const clean = {};
    const keepCols = this.constructor.columns || [];

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];

      if (!this.constructor.isBadValue(val)) {
        clean[key] = val;
      } else if (keepCols.includes(key)) {
        clean[key] = null;
      }
    }

    return clean;
  }

  // ──────────────────────────────
  // SAFE fill() – allow only good values
  // ──────────────────────────────
  async fill(attrs = {}) {
    const allowed = this.constructor.fillable || Object.keys(attrs);

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (allowed.includes(key) && !this.constructor.isBadValue(val)) {
        this._attributes[key] = val;
      }
    }
    return this;
  }

  // ──────────────────────────────
  // INSERT – validation first
  // ──────────────────────────────
  async saveNew(attrs) {
    const payload = this.sanitize(attrs || this._attributes);

    // Validate BEFORE hooks/db
    await this.constructor.validate(payload);
    await this.trigger('creating');

    // timestamps
    if (this.constructor.timestamps) {
      const now = new Date();
      payload.created_at = payload.created_at || now;
      payload.updated_at = payload.updated_at || now;
    }

    // soft deletes
    if (this.constructor.softDeletes) {
      const delCol = this.constructor.deletedAt;
      if (delCol in payload && this.constructor.isBadValue(payload[delCol])) {
        delete payload[delCol];
      }
    }

    const qb = this.constructor.query();
    DB.log('INSERT', {
      table: this.constructor.tableName,
      data: payload
    });

    const result = await qb.insert(payload);

    // handle pk
    const pk = this.constructor.primaryKey;
    const insertId = Array.isArray(result) ? result[0] : result;

    if (!(pk in payload) && insertId !== undefined) {
      payload[pk] = insertId;
    }

    this._attributes = { ...payload };
    this._original = { ...payload };
    this._exists = true;

    return this;
  }

  // ──────────────────────────────
  // UPDATE – only dirty fields
  // ──────────────────────────────
  async save() {
    if (!this._exists) return this.saveNew(this._attributes);

    await this.trigger('updating');

    const dirty = {};
    const attrs = this._attributes;
    const orig = this._original;

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];

      if (val !== orig[key] && !this.constructor.isBadValue(val)) {
        if (this.constructor.softDeletes &&
            key === this.constructor.deletedAt) {
          continue;
        }
        dirty[key] = val;
      }
    }

    const payload = this.sanitize(dirty);
    if (!Object.keys(payload).length) return this;

    // timestamps
    if (this.constructor.timestamps) {
      const now = new Date();
      payload.updated_at = now;
      this._attributes.updated_at = now;
    }

    // validate BEFORE db write
    const pk = this.constructor.primaryKey;
    await this.constructor.validate(
      { ...this._original, ...payload },
      this._attributes[pk]
    );

    const id = this._attributes[pk];
    const qb = this.constructor.query();

    DB.log('UPDATE', {
      table: this.constructor.tableName,
      data: payload,
      where: { [pk]: id }
    });

    await qb.where(pk, id).update(payload);

    this._original = { ...this.sanitize(this._attributes) };

    return this;
  }

  // ──────────────────────────────
  // update() → proxies fill + save()
  // ──────────────────────────────
  async update(attrs = {}) {
    const payload = this.sanitize(attrs);
    await this.fill(payload);
    return this.save();
  }

  static getRelations() {
    if (this._cachedRelations) return this._cachedRelations;

    const proto = this.prototype;
    const relations = {};

    // dummy instance for calling methods
    const dummy = new this({}, false);

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const fn = proto[name];
      if (typeof fn !== 'function') continue;

      let rel;
      try {
        rel = fn.call(dummy);
      } catch {
        continue;
      }

      if (!rel) continue;

      // Check if rel is one of your relation classes
      if (
        rel instanceof BelongsTo ||
        rel instanceof HasOne ||
        rel instanceof HasMany ||
        rel instanceof BelongsToMany ||
        rel instanceof MorphOne ||
        rel instanceof MorphMany ||
        rel instanceof MorphTo ||
        rel instanceof MorphToMany ||
        rel instanceof MorphedByMany ||
        rel instanceof HasManyThrough
      ) {
        rel._name = name;
        relations[name] = rel;
      }
    }

    this._cachedRelations = relations;
    return relations;
  }

  // Delete & Restore
  async delete() {
    if (!this._exists) return false;

    // Run events
    await this.trigger('deleting');

    const pk = this.constructor.primaryKey;

    // Soft delete
    if (this.constructor.softDeletes) {
      this._attributes[this.constructor.deletedAt] = new Date();
      return this.save();
    }

    // ────────────────────────────────────────
    // AUTO-DISCOVER RELATIONS
    // ────────────────────────────────────────
    const relations = this.constructor.getRelations();

    for (const relName in relations) {
      const relMeta = relations[relName];

      // Load related models (Array|Model|null)
      let related;
      try {
        related = await this[relName]();
      } catch {
        continue; // relation method may need instance values; skip if fails
      }

      if (!related) continue;

      const behavior = relMeta.deleteBehavior || 'ignore';

      switch (behavior) {

        // ──────────────────────────────────
        // RESTRICT — block delete
        // ──────────────────────────────────
        case 'restrict':
          throw new Error(
            `Cannot delete ${this.constructor.name}: related ${relName} exists`
          );

        // ──────────────────────────────────
        // DETACH — only for BelongsToMany / MorphToMany
        // ──────────────────────────────────
        case 'detach':
          // must be a pivot relation
          if (
            relMeta.pivotTable &&
            relMeta.foreignKey &&
            relMeta.relatedKey
          ) {
            const parentId = this[this.constructor.primaryKey];

            const relatedIds = Array.isArray(related)
              ? related.map(r => r[r.constructor.primaryKey])
              : [related[related.constructor.primaryKey]];

            DB.log('DETACH', {
              table: relMeta.pivotTable,
              parentKey: relMeta.foreignKey,
              relatedKey: relMeta.relatedKey,
              parentId,
              relatedIds
            });

            await new QueryBuilder(relMeta.pivotTable)
              .where(relMeta.foreignKey, parentId)
              .whereIn(relMeta.relatedKey, relatedIds)
              .delete();
          }
          break;

        // ──────────────────────────────────
        // CASCADE — delete related models
        // ──────────────────────────────────
        case 'cascade':
          if (Array.isArray(related)) {
            for (const child of related) {
              if (child && typeof child.delete === 'function')
                await child.delete();
            }
          } else if (typeof related.delete === 'function') {
            await related.delete();
          }
          break;

        // ──────────────────────────────────
        // IGNORE — do nothing
        // ──────────────────────────────────
        case 'ignore':
        default:
          break;
      }
    }

    // ────────────────────────────────────────
    // PHYSICAL DELETE
    // ────────────────────────────────────────
    const qb = this.constructor.query().where(pk, this._attributes[pk]);

    DB.log('DELETE', {
      table: this.constructor.tableName,
      pk,
      id: this._attributes[pk]
    });

    await qb.delete();

    this._exists = false;
    return true;
  }


  static async destroy(ids) {
    if (!Array.isArray(ids)) ids = [ids];
    const pk = this.primaryKey;

    // --- Load models so cascade works ---
    const models = await this.whereIn(pk, ids).get();

    for (const model of models) {
      await model.delete();  // uses the patched cascade delete
    }

    return models.length;
  }

  async restore() {
    if (!this.constructor.softDeletes) return this;
    this._attributes[this.constructor.deletedAt] = null;
    return await this.save();
  }

  // Relationships
  // Give each instance ability to create relations
  belongsTo(RelatedClass, foreignKey = null, ownerKey = null) {
    return new BelongsTo(this, RelatedClass, foreignKey, ownerKey);
  }

  hasOne(RelatedClass, foreignKey = null, localKey = null) {
    return new HasOne(this, RelatedClass, foreignKey, localKey);
  }

  hasMany(RelatedClass, foreignKey = null, localKey = null) {
    return new HasMany(this, RelatedClass, foreignKey, localKey);
  }

  belongsToMany(RelatedClass, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new BelongsToMany(this, RelatedClass, pivotTable, foreignKey, relatedKey);
  }

  hasManyThrough(RelatedClass, ThroughClass, firstKey = null, secondKey = null, localKey = null, secondLocalKey = null) {
    return new HasManyThrough(this, RelatedClass, ThroughClass, firstKey, secondKey, localKey, secondLocalKey);
  }

  morphOne(RelatedClass, morphName, localKey = null) {
    return new MorphOne(this, RelatedClass, morphName, localKey);
  }

  morphMany(RelatedClass, morphName, localKey = null) {
    return new MorphMany(this, RelatedClass, morphName, localKey);
  }

  morphTo(typeField = "morph_type", idField = "morph_id") {
    return new MorphTo(this, typeField, idField);
  }

  morphToMany(RelatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new MorphToMany(this, RelatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }

  morphedByMany(RelatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new MorphedByMany(this, RelatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }

  static with(relations) { return this.query().with(relations); }

  // Serialization & Conversion
  toObject({ relations = true } = {}) {
    const base = {};

    // copy attributes
    for (const [k, v] of Object.entries(this._attributes)) {
      if (v instanceof Date) base[k] = this.serializeDate(v);
      else if (v instanceof Model) base[k] = v.toObject();
      else base[k] = v;
    }

    // relations
    if (relations && this._relations) {
      for (const [name, rel] of Object.entries(this._relations)) {
        if (Array.isArray(rel)) {
          base[name] = rel.map(r =>
            r instanceof Model ? r.toObject() : r
          );
        } else if (rel instanceof Model) {
          base[name] = rel.toObject();
        } else if (rel && typeof rel.then === "function") {
          // relation didn't resolve yet
          base[name] = null;
        } else {
          base[name] = rel;
        }
      }
    }

    // apply hidden/visible properly
    const hidden = this.constructor.hidden || [];
    const visible = this.constructor.visible;

    let out = { ...base };

    if (visible && Array.isArray(visible)) {
      out = Object.fromEntries(
        Object.entries(out).filter(([k]) => visible.includes(k))
      );
    } else if (hidden.length) {
      for (const k of hidden) delete out[k];
    }

    return out;
  }

  toJSON() {
    try {
      return JSON.parse(JSON.stringify(this.toObject()));
    } catch {
      return this.toObject();
    }
  }
  

  toString() {
    return `${this.constructor.name} ${JSON.stringify(this.toObject(), null, 2)}`;
  }

  // Node's util.inspect custom symbol
  [util.inspect.custom]() {
    return this.toObject();
  }

  serializeDate(date) {
    return date.toISOString();
  }

  // Utility helpers
  clone(deep = false) {
    const attrs = deep
      ? (globalThis.structuredClone
          ? structuredClone(this._attributes)
          : JSON.parse(JSON.stringify(this._attributes)))
      : { ...this._attributes };

    const m = new this.constructor(attrs, this._exists);
    m._original = { ...this._original };
    return m;
  }

  only(keys = []) {
    const out = {};
    for (const k of keys) if (k in this._attributes) out[k] = this._attributes[k];
    return out;
  }

  except(keys = []) {
    const out = {};
    for (const k of Object.keys(this._attributes))
      if (!keys.includes(k)) out[k] = this._attributes[k];
    return out;
  }

  getAttribute(key) { return this._attributes[key]; }
  setAttribute(key, value) { this._attributes[key] = value; return this; }

  async refresh() {
    const pk = this.constructor.primaryKey;
    if (!this._attributes[pk]) return this;
    const fresh = await this.constructor.find(this._attributes[pk]);
    if (fresh) {
      this._attributes = { ...fresh._attributes };
      this._original = { ...fresh._original };
    }
    return this;
  }

  get exists() { return this._exists; }

  isDirty(key) {
    if (!key) return Object.keys(this._attributes).some(k => this._attributes[k] !== this._original[k]);
    return this._attributes[key] !== this._original[key];
  }

  getChanges() {
    const dirty = {};
    for (const k of Object.keys(this._attributes))
      if (this._attributes[k] !== this._original[k]) dirty[k] = this._attributes[k];
    return dirty;
  }
}

// --- BaseModel with bcrypt hashing ---
const bcrypt = tryRequire('bcrypt');
class BaseModel extends Model {
  static passwordField = 'password';
  static hashRounds = 10;

  /**
   * Lifecycle hook placeholders
   * Subclasses can override these.
   */
  async beforeCreate(attrs) {}
  async afterCreate(savedRecord) {}
  async beforeSave(attrs) {}
  async afterSave(savedRecord) {}

  /**
   * Called when inserting a new record.
   */
  async saveNew(attrs) {
    await this.beforeSave(attrs);
    await this.beforeCreate(attrs);

    await this._maybeHashPassword(attrs);
    const saved = await super.saveNew(attrs);

    await this.afterCreate(saved);
    await this.afterSave(saved);

    return saved;
  }

  /**
   * Called when updating an existing record.
   */
  async save() {
    await this.beforeSave(this._attributes);
    await this._maybeHashPassword(this._attributes);

    const saved = await super.save();

    await this.afterSave(saved);
    return saved;
  }

  /**
   * Hash password field if needed.
   */
  async _maybeHashPassword(attrs) {
    const field = this.constructor.passwordField;
    if (!attrs[field]) return;

    if (!bcrypt)
      throw new DBError('bcrypt module required. Install: npm i bcrypt');

    const isHashed =
      typeof attrs[field] === 'string' && /^\$2[abxy]\$/.test(attrs[field]);

    if (!isHashed) {
      const salt = await bcrypt.genSalt(this.constructor.hashRounds);
      attrs[field] = await bcrypt.hash(attrs[field], salt);
    }
  }

  /**
   * Check a plain text password against the hashed one.
   */
  async checkPassword(rawPassword) {
    const field = this.constructor.passwordField;
    const hashed = this._attributes[field];
    if (!hashed) return false;
    return await bcrypt.compare(rawPassword, hashed);
  }

  /**
   * Serialize model data for output.
   * Override this to customize output (e.g. hide sensitive fields).
   */
  serialize() {
    const data = { ...this._attributes };
    const passwordField = this.constructor.passwordField;

    // Remove password or other sensitive data
    if (data[passwordField]) delete data[passwordField];

    return data;
  }
}

const debug = process.env.DEBUG?.toLowerCase() === 'true';

// Initialize DB with debug value
DB.initFromEnv({ debug });

module.exports = { DB, Model, Validator, ValidationError, Collection, QueryBuilder, HasMany, HasOne, BelongsTo, BelongsToMany, DBError, BaseModel, DateTime, Duration, Interval, Info, parseFromFormat  };

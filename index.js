/**
 * nexium-orm
 * Nexium ORM - single-file CommonJS multi-driver ORM
 *
 * Drivers: mysql2/promise, pg, sqlite3
 * Hashing: bcrypt
 *
 *
 * Author: Andrew Khabweri
 */

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

  // raw: returns rows (not [rows]) to keep API simple
  static async raw(sql, params = []) {
    // retry logic for transient errors
    let attempt = 0;
    let lastErr;
    while (attempt < this.retryAttempts) {
      attempt++;
      const pool = await this.connect();
      const start = Date.now();
      try {
        this.log(sql, params);
        if (this.driver === 'mysql') {
          const [rows] = await pool.query(sql, params);
          const time = Date.now() - start;
          this.log(sql, params, time);
          return rows;
        } else if (this.driver === 'pg') {
          const { text, values } = this._pgConvertPlaceholders(sql, params);
          const res = await pool.query(text, values);
          const time = Date.now() - start;
          this.log(text, values, time);
          return res.rows;
        } else if (this.driver === 'sqlite') {
          const [rows] = await pool.query(sql, params);
          const time = Date.now() - start;
          this.log(sql, params, time);
          return rows;
        } else {
          throw new DBError('Unsupported driver in raw()');
        }
      } catch (err) {
        lastErr = err;
        this._emit('error', { err, sql, params, attempt });
        // simple detection for retryable errors (connection lost)
        const msg = String(err && err.message || '').toLowerCase();
        if (attempt < this.retryAttempts && (msg.includes('dead') || msg.includes('lost') || msg.includes('connection') || msg.includes('timeout'))) {
          Logger.warn('Transient DB error, retrying...', attempt, msg);
          // try to reinitialize pool
          try { await this.end(); } catch (e) {}
          await new Promise(res => setTimeout(res, 100 * attempt));
          continue;
        }
        throw new DBError('Query failed: ' + (err.message || err) , { original: err, sql, params });
      }
    }
    throw lastErr || new DBError('Unknown DB raw error');
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

// --- Validators (basic set) ---
const Validators = {
  required: (v) => v !== undefined && v !== null && v !== '',
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  min: (len) => (v) => (v != null && String(v).length >= Number(len)),
  max: (len) => (v) => (v != null && String(v).length <= Number(len)),
  regex: (re) => (v) => (new RegExp(re)).test(v)
};

// validate object against rules: { field: ['required','email','min:3'] }
function validate(attrs = {}, rules = {}) {
  const errors = {};
  for (const f of Object.keys(rules)) {
    const rs = Array.isArray(rules[f]) ? rules[f] : [rules[f]];
    for (const r of rs) {
      if (typeof r === 'string') {
        if (r === 'required' && !Validators.required(attrs[f])) {
          (errors[f] = errors[f] || []).push('required');
        } else if (r === 'email' && !Validators.email(attrs[f])) {
          (errors[f] = errors[f] || []).push('invalid_email');
        } else if (r.startsWith('min:')) {
          const n = r.split(':')[1]; if (!Validators.min(n)(attrs[f])) (errors[f] = errors[f] || []).push('min:' + n);
        } else if (r.startsWith('max:')) {
          const n = r.split(':')[1]; if (!Validators.max(n)(attrs[f])) (errors[f] = errors[f] || []).push('max:' + n);
        } else if (r.startsWith('regex:')) {
          const rx = r.split(':').slice(1).join(':'); if (!Validators.regex(rx)(attrs[f])) (errors[f] = errors[f] || []).push('regex');
        }
      } else if (typeof r === 'function') {
        if (!r(attrs[f])) (errors[f] = errors[f] || []).push('failed_custom');
      }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// --- QueryBuilder (fluent) ---
class QueryBuilder {
  constructor(table, modelClass = null) {
    this.table = table;
    this.modelClass = modelClass;
    this._select = ['*'];
    this._joins = [];
    this._wheres = [];
    this._bindings = [];
    this._orders = [];
    this._group = [];
    this._having = [];
    this._limit = null;
    this._offset = null;
    this._forUpdate = false;
    this._with = [];
    this._ignoreSoftDeletes = false;
  }

  select(...cols) { if (cols.length) this._select = cols.flat(); return this; }
  join(type, table, first, operator, second) { this._joins.push({type, table, first, operator, second}); return this; }
  leftJoin(table, first, operator, second){ return this.join('LEFT', table, first, operator, second); }
  innerJoin(table, first, operator, second){ return this.join('INNER', table, first, operator, second); }

  where(column, operator, value) {
    if (arguments.length === 2) { value = operator; operator = '='; }
    this._wheres.push({ column, operator, value, boolean: 'AND' });
    this._bindings.push(value);
    return this;
  }
  orWhere(column, operator, value){ if (arguments.length === 2) { value = operator; operator = '='; } this._wheres.push({ column, operator, value, boolean: 'OR' }); this._bindings.push(value); return this; }

  whereIn(column, values = []) {
    if (!Array.isArray(values)) throw new DBError('whereIn expects an array');
    if (!values.length) { this._wheres.push({ raw: '0 = 1' }); return this; }
    const placeholders = values.map(_=>'?').join(',');
    this._wheres.push({ raw: `${escapeId(column)} IN (${placeholders})` });
    this._bindings.push(...values);
    return this;
  }

  whereNull(column) { this._wheres.push({ raw: `${escapeId(column)} IS NULL`, boolean: 'AND' }); return this; }
  whereNotNull(column) { this._wheres.push({ raw: `${escapeId(column)} IS NOT NULL`, boolean: 'AND' }); return this; }
  whereBetween(column, [a, b]) { this._wheres.push({ raw: `${escapeId(column)} BETWEEN ? AND ?`, boolean: 'AND' }); this._bindings.push(a, b); return this; }

  orderBy(col, dir='ASC'){ this._orders.push([col, dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC']); return this; }
  groupBy(...cols){ this._group.push(...cols.flat()); return this; }
  having(column, operator, value){ this._having.push({column, operator, value}); this._bindings.push(value); return this; }
  limit(n){ this._limit = Number(n); return this; }
  offset(n){ this._offset = Number(n); return this; }
  forUpdate(){ this._forUpdate = true; return this; }

  with(relations){ this._with = Array.isArray(relations) ? relations : [relations]; return this; }
  ignoreSoftDeletes(){ this._ignoreSoftDeletes = true; return this; }

  _clone() {
    const c = new QueryBuilder(this.table, null);
    c._select = this._select.slice();
    c._joins = JSON.parse(JSON.stringify(this._joins));
    c._wheres = JSON.parse(JSON.stringify(this._wheres));
    c._bindings = this._bindings.slice();
    c._orders = this._orders.slice();
    c._group = this._group.slice();
    c._having = this._having.slice();
    c._limit = this._limit;
    c._offset = this._offset;
    c._forUpdate = this._forUpdate;
    c._with = this._with.slice();
    return c;
  }

  _compileSelect() {
    const parts = [];
    parts.push('SELECT');
    parts.push(this._select.join(', '));
    parts.push('FROM');
    parts.push(this.table);
    if (this._joins.length) {
      for (const j of this._joins) {
        parts.push(`${j.type} JOIN ${j.table} ON ${j.first} ${j.operator} ${j.second}`);
      }
    }
    if (this._wheres.length) {
      const whereSqls = this._wheres.map((w, idx) => {
        if (w.raw) return (idx === 0 ? 'WHERE ' : (w.boolean + ' ')) + w.raw;
        return (idx === 0 ? 'WHERE ' : (w.boolean + ' ')) + `${escapeId(w.column)} ${w.operator} ?`;
      });
      parts.push(whereSqls.join(' '));
    }
    if (this._group.length) parts.push('GROUP BY ' + this._group.map(escapeId).join(', '));
    if (this._having.length) parts.push('HAVING ' + this._having.map(h=>`${escapeId(h.column)} ${h.operator} ?`).join(' AND '));
    if (this._orders.length) parts.push('ORDER BY ' + this._orders.map(o=>`${o[0]} ${o[1]}`).join(', '));
    if (this._limit !== null) parts.push('LIMIT ' + this._limit);
    if (this._offset !== null) parts.push('OFFSET ' + this._offset);
    if (this._forUpdate) parts.push('FOR UPDATE');
    return parts.join(' ');
  }

  async get() {
    const sql = this._compileSelect();
    DB.log(sql, this._bindings);
    const rows = await DB.raw(sql, this._bindings);
    if (this.modelClass) {
      const models = rows.map(r => new this.modelClass(r, true));
      if (this._with.length) return await this._eagerLoad(models);
      return models;
    }
    return rows;
  }

  async first() { this.limit(1); const res = await this.get(); return res && res.length ? res[0] : null; }

  async count(column = '*') {
    const clone = this._clone();
    clone._select = [`COUNT(${column}) as aggregate`];
    clone._orders = [];
    clone._limit = null;
    clone._offset = null;
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const rows = await DB.raw(sql, clone._bindings);
    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  async _aggregate(expr) {
    const clone = this._clone();
    clone._select = [`${expr} as aggregate`];
    clone._orders = [];
    clone._limit = null;
    clone._offset = null;
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const rows = await DB.raw(sql, clone._bindings);
    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  async sum(column) { return await this._aggregate(`SUM(${escapeId(column)})`); }
  async avg(column) { return await this._aggregate(`AVG(${escapeId(column)})`); }
  async min(column) { return await this._aggregate(`MIN(${escapeId(column)})`); }
  async max(column) { return await this._aggregate(`MAX(${escapeId(column)})`); }
  async countDistinct(column) { return await this._aggregate(`COUNT(DISTINCT ${escapeId(column)})`); }

  async pluck(column) {
    const clone = this._clone();
    clone._select = [escapeId(column)];
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const rows = await DB.raw(sql, clone._bindings);
    return rows.map(r => r[Object.keys(r)[0]]);
  }

  async paginate(page = 1, perPage = 15) {
    page = Math.max(1, Number(page));
    perPage = Math.max(1, Number(perPage));
    const total = await this.count('*');
    const offset = (page - 1) * perPage;
    this.limit(perPage).offset(offset);
    const data = await this.get();
    return { total, perPage, page, lastPage: Math.ceil(total / perPage), data };
  }

  async _eagerLoad(models) {
    if (!models.length) return models;
    const model = models[0].constructor;
    for (const relName of this._with) {
      if (typeof model.prototype[relName] !== 'function') continue;
      const exampleRelation = model.prototype[relName].call(models[0]);
      await exampleRelation.eagerLoad(models, relName);
    }
    return models;
  }
}

// --- Relations ---
class Relation {
  constructor(parent, relatedClass, foreignKey, localKey) {
    this.parent = parent;
    this.relatedClass = relatedClass;
    this.foreignKey = foreignKey;
    this.localKey = localKey;
  }
}

class HasMany extends Relation {
  constructor(parent, relatedClass, foreignKey = null, localKey = 'id'){
    const fk = foreignKey || (parent.constructor.tableSingular ? `${parent.constructor.tableSingular}_id` : `${parent.constructor.table}_id`);
    super(parent, relatedClass, fk, localKey);
  }
  async get(){
    const Related = this.relatedClass;
    return await Related.where(this.foreignKey, this.parent[this.localKey]).get();
  }
  async eagerLoad(parents, relName){
    const Related = this.relatedClass;
    const keys = parents.map(p=>p[this.localKey]);
    if (!keys.length) { for (const p of parents) p[relName] = []; return; }
    const rows = await Related.whereIn(this.foreignKey, keys).get();
    const map = new Map();
    for (const r of rows) {
      const k = r[this.foreignKey];
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    for (const p of parents) p[relName] = map.get(p[this.localKey]) || [];
  }
}

class HasOne extends Relation {
  constructor(parent, relatedClass, foreignKey = null, localKey = 'id'){
    const fk = foreignKey || `${parent.constructor.table}_id`;
    super(parent, relatedClass, fk, localKey);
  }
  async get(){
    const Related = this.relatedClass;
    return await Related.where(this.foreignKey, this.parent[this.localKey]).first();
  }
  async eagerLoad(parents, relName){
    const Related = this.relatedClass;
    const keys = parents.map(p=>p[this.localKey]);
    if (!keys.length) { for (const p of parents) p[relName] = null; return; }
    const rows = await Related.whereIn(this.foreignKey, keys).get();
    const map = new Map();
    for (const r of rows) map.set(r[this.foreignKey], r);
    for (const p of parents) p[relName] = map.get(p[this.localKey]) || null;
  }
}

class BelongsTo extends Relation {
  constructor(parent, relatedClass, foreignKey, ownerKey = 'id'){ super(parent, relatedClass, foreignKey, ownerKey); }
  async get(){
    const Related = this.relatedClass;
    return await Related.where(this.localKey, this.parent[this.foreignKey]).first();
  }
  async eagerLoad(parents, relName){
    const Related = this.relatedClass;
    const keys = parents.map(p=>p[this.foreignKey]).filter(k=>k!==undefined && k!==null);
    if (!keys.length) {
      for (const p of parents) p[relName] = null; return;
    }
    const rows = await Related.whereIn(this.localKey, keys).get();
    const map = new Map();
    for (const r of rows) map.set(r[this.localKey], r);
    for (const p of parents) p[relName] = map.get(p[this.foreignKey]) || null;
  }
}

class BelongsToMany extends Relation {
  constructor(parent, relatedClass, pivotTable, foreignKey, relatedKey, localKey = 'id', relatedPrimaryKey = 'id') {
    super(parent, relatedClass, foreignKey, localKey);
    this.pivotTable = pivotTable;
    this.relatedKey = relatedKey;
    this.relatedPrimaryKey = relatedPrimaryKey;
  }

  async get() {
    const Related = this.relatedClass;
    const sql = `SELECT r.* FROM ${Related.tableName} AS r
      INNER JOIN ${this.pivotTable} AS p ON r.${this.relatedPrimaryKey} = p.${this.relatedKey}
      WHERE p.${this.foreignKey} = ?`;
    DB.log(sql, [this.parent[this.localKey]]);
    const rows = await DB.raw(sql, [this.parent[this.localKey]]);
    return rows.map(r => new Related(r, true));
  }

  async attach(relatedId) {
    if (relatedId === undefined || relatedId === null) throw new DBError('relatedId is required for attach');
    const sql = `INSERT INTO ${this.pivotTable} (${this.foreignKey}, ${this.relatedKey}) VALUES (?, ?)`;
    DB.log(sql, [this.parent[this.localKey], relatedId]);
    await DB.raw(sql, [this.parent[this.localKey], relatedId]);
  }

  async detach(relatedId = null) {
    const conditions = [`${this.foreignKey} = ?`];
    const params = [this.parent[this.localKey]];
    if (relatedId) { conditions.push(`${this.relatedKey} = ?`); params.push(relatedId); }
    const sql = `DELETE FROM ${this.pivotTable} WHERE ${conditions.join(' AND ')}`;
    DB.log(sql, params);
    await DB.raw(sql, params);
  }

  async eagerLoad(parents, relName) {
    const Related = this.relatedClass;
    const keys = parents.map(p => p[this.localKey]);
    if (!keys.length) { for (const p of parents) p[relName] = []; return; }
    const placeholders = keys.map(_=>'?').join(',');
    const sql = `SELECT r.*, p.${this.foreignKey} as _pivot_fk FROM ${Related.tableName} AS r INNER JOIN ${this.pivotTable} AS p ON r.${this.relatedPrimaryKey} = p.${this.relatedKey} WHERE p.${this.foreignKey} IN (${placeholders})`;
    DB.log(sql, keys);
    const rows = await DB.raw(sql, keys);
    const map = new Map();
    for (const r of rows) {
      const fk = r._pivot_fk;
      if (!map.has(fk)) map.set(fk, []);
      map.get(fk).push(new Related(r, true));
    }
    for (const p of parents) p[relName] = map.get(p[this.localKey]) || [];
  }
}

// --- Model base class ---
class Model {
  static table = null;
  static primaryKey = 'id';
  static timestamps = false;
  static fillable = null;
  static tableSingular = null;

  static softDeletes = false;
  static deletedAt = 'deleted_at';

  constructor(attributes = {}, fresh = false) {
    this._attributes = {};
    this._original = {};
    this._exists = !!fresh;
    for (const k of Object.keys(attributes)) this._attributes[k] = attributes[k];
    this._original = Object.assign({}, this._attributes);
    for (const k of Object.keys(this._attributes)) {
      Object.defineProperty(this, k, { get: () => this._attributes[k], enumerable: true });
    }
  }

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

  async trigger(event) {
    const events = this.constructor._events?.[event] || [];
    for (const fn of events) await fn(this);
  }

  static query({ withTrashed = false } = {}) {
    const qb = new QueryBuilder(this.tableName, this);
    if (this.softDeletes && !withTrashed) {
      qb._wheres = qb._wheres.slice();
      qb._wheres.push({ raw: `${DB.escapeId(this.deletedAt)} IS NULL` });
    }
    return qb;
  }

  static withTrashed() { return this.query({ withTrashed: true }); }

  static async all(){ return await this.query().get(); }
  static where(...args){ const qb = this.query(); return qb.where(...args); }
  static whereIn(col, arr){ return this.query().whereIn(col, arr); }
  static async find(id){ return await this.query().where(this.primaryKey, id).first(); }
  static async findBy(col, value){ return await this.query().where(col, value).first(); }

  static async create(attrs){ const m = new this(); return await m.saveNew(attrs); }

  static async raw(sql, params){ return await DB.raw(sql, params); }

  static async transaction(fn){ return await DB.transaction(fn); }

  async fill(attrs){
    const keys = this.constructor.fillable ? this.constructor.fillable : Object.keys(attrs);
    for (const k of Object.keys(attrs)) if (!this.constructor.fillable || keys.includes(k)) this._attributes[k] = attrs[k];
    return this;
  }

  async saveNew(attrs){
    await this.fill(attrs);
    await this.trigger('creating');
    if (this.constructor.timestamps) {
      const now = new Date();
      this._attributes.created_at = this._attributes.created_at || now;
      this._attributes.updated_at = this._attributes.updated_at || now;
    }
    const columns = Object.keys(this._attributes);
    if (!columns.length) throw new DBError('No attributes to insert');
    const placeholders = columns.map(_=>'?').join(',');
    const colsEsc = columns.map(c=>DB.escapeId(c)).join(',');
    const sql = `INSERT INTO ${this.constructor.tableName} (${colsEsc}) VALUES (${placeholders})`;
    const params = columns.map(c=>this._attributes[c]);
    DB.log(sql, params);
    // driver-specific insert handling for returning id
    if (DB.driver === 'mysql') {
      const [res] = await (await DB.connect()).query(sql, params);
      const pk = this.constructor.primaryKey || 'id';
      if (!this._attributes[pk]) this._attributes[pk] = res.insertId;
    } else if (DB.driver === 'pg') {
      const { text, values } = DB._pgConvertPlaceholders(sql + ` RETURNING *`, params);
      const pool = await DB.connect();
      const res = await pool.query(text, values);
      const returned = res.rows && res.rows[0] ? res.rows[0] : null;
      const pk = this.constructor.primaryKey || 'id';
      if (returned && !this._attributes[pk]) this._attributes[pk] = returned[pk];
    } else if (DB.driver === 'sqlite') {
      const pool = await DB.connect();
      const [r] = await pool.query(sql, params);
      const pk = this.constructor.primaryKey || 'id';
      if (!this._attributes[pk]) this._attributes[pk] = r.lastInsertRowid || r.lastInsertRowId || null;
    } else {
      await DB.raw(sql, params);
    }
    this._exists = true;
    this._original = Object.assign({}, this._attributes);
    for (const k of Object.keys(this._attributes)) if (!(k in this)) Object.defineProperty(this, k, { get: () => this._attributes[k], enumerable: true });
    return this;
  }

  async save(){
    if (!this._exists) return await this.saveNew(this._attributes);
    await this.trigger('updating');
    const dirty = {};
    for (const k of Object.keys(this._attributes)) if (this._attributes[k] !== this._original[k]) dirty[k] = this._attributes[k];
    if (!Object.keys(dirty).length) return this;
    if (this.constructor.timestamps) this._attributes.updated_at = new Date();
    const columns = Object.keys(dirty);
    const sets = columns.map(c=>`${DB.escapeId(c)} = ?`).join(', ');
    const params = columns.map(c=>dirty[c]);
    const pk = this.constructor.primaryKey;
    params.push(this._attributes[pk]);
    const sql = `UPDATE ${this.constructor.tableName} SET ${sets} WHERE ${DB.escapeId(pk)} = ?`;
    DB.log(sql, params);
    await DB.raw(sql, params);
    this._original = Object.assign({}, this._attributes);
    return this;
  }

  async delete(){
    if (!this._exists) return false;
    await this.trigger('deleting');
    const pk = this.constructor.primaryKey;
    if (this.constructor.softDeletes) {
      this._attributes[this.constructor.deletedAt] = new Date();
      return await this.save();
    }
    const sql = `DELETE FROM ${this.constructor.tableName} WHERE ${DB.escapeId(pk)} = ?`;
    DB.log(sql, [this._attributes[pk]]);
    await DB.raw(sql, [this._attributes[pk]]);
    this._exists = false;
    return true;
  }

  async restore(){
    if (!this.constructor.softDeletes) return this;
    this._attributes[this.constructor.deletedAt] = null;
    return await this.save();
  }

  hasMany(relatedClass, foreignKey = null, localKey = 'id'){ return new HasMany(this, relatedClass, foreignKey, localKey); }
  hasOne(relatedClass, foreignKey = null, localKey = 'id'){ return new HasOne(this, relatedClass, foreignKey, localKey); }
  belongsTo(relatedClass, foreignKey, ownerKey = 'id'){ return new BelongsTo(this, relatedClass, foreignKey, ownerKey); }
  belongsToMany(relatedClass, pivotTable, foreignKey, relatedKey, localKey = 'id', relatedPrimaryKey = 'id') { return new BelongsToMany(this, relatedClass, pivotTable, foreignKey, relatedKey, localKey, relatedPrimaryKey); }

  static with(relations){ return this.query().with(relations); }

  toJSON(){ return Object.assign({}, this._attributes); }
}

// --- BaseModel with bcrypt hashing ---
const bcrypt = tryRequire('bcrypt');
class BaseModel extends Model {
  static passwordField = 'password';
  static hashRounds = 10;

  async saveNew(attrs) {
    await this._maybeHashPassword(attrs);
    return super.saveNew(attrs);
  }

  async save() {
    await this._maybeHashPassword(this._attributes);
    return super.save();
  }

  async _maybeHashPassword(attrs) {
    const field = this.constructor.passwordField;
    if (!attrs[field]) return;
    if (!bcrypt) throw new DBError('bcrypt module required. Install: npm i bcrypt');
    const isHashed = typeof attrs[field] === 'string' && /^\$2[abxy]\$/.test(attrs[field]);
    if (!isHashed) {
      const salt = await bcrypt.genSalt(this.constructor.hashRounds);
      attrs[field] = await bcrypt.hash(attrs[field], salt);
    }
  }

  async checkPassword(rawPassword) {
    const field = this.constructor.passwordField;
    const hashed = this._attributes[field];
    if (!hashed) return false;
    return await bcrypt.compare(rawPassword, hashed);
  }
}

const debug = process.env.DEBUG?.toLowerCase() === 'true';

// Initialize DB with debug value
DB.initFromEnv({ debug });

// --- Exports ---
module.exports = { DB, Model, QueryBuilder, HasMany, HasOne, BelongsTo, BelongsToMany,validate, DBError, BaseModel };

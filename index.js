// nexium-orm-advanced.js
// Production-ready single-file ORM (MySQL) for Nexium
// Upgrades: aggregates, many-to-many, events, soft deletes, caching, profiling,
// identifier escaping, safer QueryBuilder cloning, paginate, pluck, input validation
const mysql = (() => {
  try { return require('mysql2/promise'); } catch (e) { throw new Error('Please install mysql2: npm i mysql2'); }
})();

class DB {
  static pool = null;
  static config = null;
  static debug = false;
  static cache = new Map();

  static initFromEnv({ debug = false } = {}) {
    const cfg = {
      host: process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1',
      user: process.env.DATABASE_USER || process.env.DB_USER || process.env.DB_USERNAME || 'root',
      password: process.env.DATABASE_PASSWORD || process.env.DB_PASS || '',
      database: process.env.DATABASE_NAME || process.env.DB_NAME || process.env.DB_DATABASE || undefined,
      port: process.env.DATABASE_PORT ? Number(process.env.DATABASE_PORT) : 3306,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
      queueLimit: 0,
      namedPlaceholders: false
    };
    this.config = cfg;
    this.debug = !!debug;
  }

  static async connect() {
    if (!this.config) this.initFromEnv();
    if (this.pool) return this.pool;
    this.pool = mysql.createPool(this.config);
    return this.pool;
  }

  static async end() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  static async transaction(fn) {
    const pool = await this.connect();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const res = await fn(conn);
      await conn.commit();
      conn.release();
      return res;
    } catch (err) {
      try { await conn.rollback(); } catch (e) {}
      conn.release();
      throw err;
    }
  }

  static log(sql, params) {
    if (this.debug) {
      console.log('[NEXIUM-ORM]', sql, params && params.length ? params : '');
    }
  }

  static async raw(sql, params = []) {
    const pool = await this.connect();
    this.log(sql, params);
    const [rows] = await pool.query(sql, params);
    return rows;
  }

  static async timedQuery(sql, params = []) {
    const pool = await this.connect();
    const start = Date.now();
    this.log(sql, params);
    const [rows] = await pool.query(sql, params);
    const time = Date.now() - start;
    if (this.debug) console.log(`[SQL ${time}ms] ${sql}`);
    return rows;
  }

  static async cached(sql, params = [], ttlMs = 0) {
    const key = JSON.stringify([sql, params]);
    const now = Date.now();
    const entry = this.cache.get(key);
    if (entry && (ttlMs === 0 || (now - entry.ts) < ttlMs)) return entry.value;
    const rows = await this.raw(sql, params);
    this.cache.set(key, { value: rows, ts: now });
    return rows;
  }
}

// Helper: safely escape identifiers (table/column names) with backticks
function escapeId(identifier) {
  if (identifier === '*') return '*';
  // allow expressions and aliases like `users u` or `COUNT(*)` etc.
  if (identifier.includes(' AS ') || identifier.includes(' as ') || /\s/.test(identifier)) return identifier;
  return '`' + identifier.replace(/`/g, '``') + '`';
}

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

  whereIn(column, values = []){
    if (!Array.isArray(values)) throw new Error('whereIn expects an array');
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

  // produce a shallow clone of the querybuilder for aggregates/pagination
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
    const pool = await DB.connect();
    const sql = this._compileSelect();
    DB.log(sql, this._bindings);
    const [rows] = await pool.query(sql, this._bindings);
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
    const pool = await DB.connect();
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const [rows] = await pool.query(sql, clone._bindings);
    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  async _aggregate(expr) {
    const clone = this._clone();
    clone._select = [`${expr} as aggregate`];
    clone._orders = [];
    clone._limit = null;
    clone._offset = null;
    const pool = await DB.connect();
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const [rows] = await pool.query(sql, clone._bindings);
    return rows[0] ? Number(rows[0].aggregate) : 0;
  }

  async sum(column) { return await this._aggregate(`SUM(${escapeId(column)})`); }
  async avg(column) { return await this._aggregate(`AVG(${escapeId(column)})`); }
  async min(column) { return await this._aggregate(`MIN(${escapeId(column)})`); }
  async max(column) { return await this._aggregate(`MAX(${escapeId(column)})`); }

  async pluck(column) {
    const clone = this._clone();
    clone._select = [escapeId(column)];
    const pool = await DB.connect();
    const sql = clone._compileSelect();
    DB.log(sql, clone._bindings);
    const [rows] = await pool.query(sql, clone._bindings);
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
    const sql = `SELECT r.* FROM ${Related.tableName} AS r\n      INNER JOIN ${this.pivotTable} AS p ON r.${this.relatedPrimaryKey} = p.${this.relatedKey}\n      WHERE p.${this.foreignKey} = ?`;
    const pool = await DB.connect();
    DB.log(sql, [this.parent[this.localKey]]);
    const [rows] = await pool.query(sql, [this.parent[this.localKey]]);
    return rows.map(r => new Related(r, true));
  }

  async attach(relatedId) {
    if (relatedId === undefined || relatedId === null) throw new Error('relatedId is required for attach');
    const sql = `INSERT INTO ${this.pivotTable} (${this.foreignKey}, ${this.relatedKey}) VALUES (?, ?)`;
    const pool = await DB.connect();
    DB.log(sql, [this.parent[this.localKey], relatedId]);
    await pool.query(sql, [this.parent[this.localKey], relatedId]);
  }

  async detach(relatedId = null) {
    const pool = await DB.connect();
    const conditions = [`${this.foreignKey} = ?`];
    const params = [this.parent[this.localKey]];
    if (relatedId) { conditions.push(`${this.relatedKey} = ?`); params.push(relatedId); }
    const sql = `DELETE FROM ${this.pivotTable} WHERE ${conditions.join(' AND ')}`;
    DB.log(sql, params);
    await pool.query(sql, params);
  }

  async eagerLoad(parents, relName) {
    const Related = this.relatedClass;
    const keys = parents.map(p => p[this.localKey]);
    if (!keys.length) { for (const p of parents) p[relName] = []; return; }
    const placeholders = keys.map(_=>'?').join(',');
    const sql = `SELECT r.*, p.${this.foreignKey} as _pivot_fk FROM ${Related.tableName} AS r INNER JOIN ${this.pivotTable} AS p ON r.${this.relatedPrimaryKey} = p.${this.relatedKey} WHERE p.${this.foreignKey} IN (${placeholders})`;
    const pool = await DB.connect();
    DB.log(sql, keys);
    const [rows] = await pool.query(sql, keys);
    const map = new Map();
    for (const r of rows) {
      const fk = r._pivot_fk;
      if (!map.has(fk)) map.set(fk, []);
      map.get(fk).push(new Related(r, true));
    }
    for (const p of parents) p[relName] = map.get(p[this.localKey]) || [];
  }
}


class Model {
  static table = null;
  static primaryKey = 'id';
  static timestamps = false;
  static fillable = null;
  static tableSingular = null;

  // soft delete support
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
    if (!this.table) throw new Error('Model.table must be set');
    return this.table;
  }

  // events booting
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

  // query builder factory
  static query({ withTrashed = false } = {}) {
    const qb = new QueryBuilder(this.tableName, this);
    if (this.softDeletes && !withTrashed) {
      qb._wheres = qb._wheres.slice();
      qb._wheres.push({ raw: `${escapeId(this.deletedAt)} IS NULL` });
    }
    return qb;
  }

  static withTrashed() { return this.query({ withTrashed: true }); }

  static async all(){ return await this.query().get(); }
  static where(...args){ const qb = this.query(); return qb.where(...args); }
  static whereIn(col, arr){ return this.query().whereIn(col, arr); }
  static async find(id){ return await this.query().where(this.primaryKey, id).first(); }
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
    if (!columns.length) throw new Error('No attributes to insert');
    const placeholders = columns.map(_=>'?').join(',');
    const colsEsc = columns.map(escapeId).join(',');
    const sql = `INSERT INTO ${this.constructor.tableName} (${colsEsc}) VALUES (${placeholders})`;
    const params = columns.map(c=>this._attributes[c]);
    const pool = await DB.connect();
    DB.log(sql, params);
    const [res] = await pool.query(sql, params);
    const pk = this.constructor.primaryKey || 'id';
    if (!this._attributes[pk]) this._attributes[pk] = res.insertId;
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
    const sets = columns.map(c=>`${escapeId(c)} = ?`).join(', ');
    const params = columns.map(c=>dirty[c]);
    const pk = this.constructor.primaryKey;
    params.push(this._attributes[pk]);
    const sql = `UPDATE ${this.constructor.tableName} SET ${sets} WHERE ${escapeId(pk)} = ?`;
    const pool = await DB.connect();
    DB.log(sql, params);
    await pool.query(sql, params);
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
    const sql = `DELETE FROM ${this.constructor.tableName} WHERE ${escapeId(pk)} = ?`;
    const pool = await DB.connect();
    DB.log(sql, [this._attributes[pk]]);
    await pool.query(sql, [this._attributes[pk]]);
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

const bcrypt = require('bcrypt');

class BaseModel extends Model {
  static passwordField = 'password'; // You can override per model
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

    // Avoid double-hashing
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

module.exports = { DB, Model, QueryBuilder, HasMany, HasOne, BelongsTo, BelongsToMany, BaseModel };

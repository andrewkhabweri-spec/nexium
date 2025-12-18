export class DB {
    static driver: any;
    static config: any;
    static pool: any;
    static debug: boolean;
    static cache: SimpleCache;
    static eventHandlers: {
        query: any[];
        error: any[];
    };
    static retryAttempts: number;
    /**
     * Initialize from env/config
     * options: { driver, debug, config, retryAttempts }
     */
    static initFromEnv({ driver, debug, config, retryAttempts }?: {
        driver?: string;
        debug?: string | boolean;
        config?: any;
        retryAttempts?: number;
    }): void;
    static on(event: any, fn: any): void;
    static _emit(event: any, payload: any): void;
    static _ensureModule(): {
        module: any;
        name: string;
    };
    static connect(): Promise<any>;
    static end(): Promise<void>;
    static log(sql: any, params: any, timeMs?: any): void;
    static _pgConvertPlaceholders(sql: any, params?: any[]): {
        text: any;
        values: any[];
    };
    static raw(sql: any, params?: any[], options?: {}): Promise<any>;
    static transaction(fn: any): Promise<any>;
    static escapeId(identifier: any): any;
    static cached(sql: any, params?: any[], ttlMs?: number): Promise<any>;
}
export class Model {
    static table: any;
    static primaryKey: string;
    static slugKey: string;
    static timestamps: boolean;
    static fillable: any;
    static tableSingular: any;
    static softDeletes: boolean;
    static deletedAt: string;
    static hidden: any[];
    static visible: any;
    static rules: {};
    static customMessages: {};
    static _load: any[];
    static validate(data: any, id: any, ignoreId?: any): Promise<Validator>;
    static get tableName(): any;
    static boot(): void;
    static on(event: any, handler: any): void;
    static before(event: any, handler: any): void;
    static after(event: any, handler: any): void;
    static query({ withTrashed }?: {
        withTrashed?: boolean;
    }): QueryBuilder;
    static setTable(table: any): void;
    static withTrashed(): QueryBuilder;
    static all(): Promise<Collection>;
    static where(...args: any[]): QueryBuilder;
    static whereIn(col: any, arr: any): QueryBuilder;
    static whereNot(...args: any[]): QueryBuilder;
    static whereNotIn(col: any, arr: any): QueryBuilder;
    static whereNull(col: any): QueryBuilder;
    static find(value: any): Promise<any>;
    static findOrFail(value: any): Promise<any>;
    static findBy(col: any, value: any): Promise<any>;
    static findByOrFail(col: any, value: any): Promise<any>;
    static findManyBy(col: any, values?: any[]): Promise<any[] | Collection>;
    static findMany(ids?: any[]): Promise<any[] | Collection>;
    static first(...args: any[]): Promise<any>;
    static firstOrFail(...args: any[]): Promise<any>;
    static firstOrNew(whereAttrs: any, defaults?: {}): Promise<any>;
    static firstOrCreate(whereAttrs: any, defaults?: {}): Promise<any>;
    static updateOrCreate(whereAttrs: any, values?: {}): Promise<any>;
    static create(attrs?: {}): Promise<Model>;
    static createMany(arr?: any[]): Promise<any[]>;
    static fetchOrNewUpMany(list?: any[], defaults?: {}): Promise<any[]>;
    static fetchOrCreateMany(list?: any[], defaults?: {}): Promise<any[]>;
    static updateOrCreateMany(items?: any[]): Promise<any[]>;
    static truncate(): Promise<void>;
    static raw(sql: any, params: any): Promise<any>;
    static transaction(fn: any): Promise<any>;
    static isBadValue(value: any): boolean;
    static getRelations(): {};
    static destroy(ids: any): Promise<number>;
    static with(relations: any): QueryBuilder;
    constructor(attributes?: {}, fresh?: boolean, data?: {});
    _attributes: {};
    _original: {};
    _relations: {};
    _exists: boolean;
    get length(): number;
    count(): number;
    trigger(event: any): Promise<void>;
    sanitize(attrs?: {}): {};
    fill(attrs?: {}): Promise<this>;
    merge(attrs?: {}): Promise<this>;
    saveNew(attrs: any): Promise<this>;
    save(): Promise<this>;
    update(attrs?: {}): Promise<this>;
    delete(): Promise<boolean | this>;
    restore(): Promise<this>;
    belongsTo(RelatedClass: any, foreignKey?: any, ownerKey?: any): BelongsTo;
    hasOne(RelatedClass: any, foreignKey?: any, localKey?: any): HasOne;
    hasMany(RelatedClass: any, foreignKey?: any, localKey?: any): HasMany;
    belongsToMany(RelatedClass: any, pivotTable?: any, foreignKey?: any, relatedKey?: any): BelongsToMany;
    hasManyThrough(RelatedClass: any, ThroughClass: any, firstKey?: any, secondKey?: any, localKey?: any, secondLocalKey?: any): HasManyThrough;
    morphOne(RelatedClass: any, morphName: any, localKey?: any): MorphOne;
    morphMany(RelatedClass: any, morphName: any, localKey?: any): MorphMany;
    morphTo(typeField?: string, idField?: string): MorphTo;
    morphToMany(RelatedClass: any, morphName: any, pivotTable?: any, foreignKey?: any, relatedKey?: any): MorphToMany;
    morphedByMany(RelatedClass: any, morphName: any, pivotTable?: any, foreignKey?: any, relatedKey?: any): MorphedByMany;
    load(relations: any): Promise<this>;
    toObject({ relations }?: {
        relations?: boolean;
    }): {};
    toJSON(): {};
    toString(): string;
    serializeDate(date: any): any;
    clone(deep?: boolean): any;
    only(keys?: any[]): {};
    except(keys?: any[]): {};
    getAttribute(key: any): any;
    setAttribute(key: any, value: any): this;
    refresh(): Promise<this>;
    get exists(): boolean;
    isDirty(key: any): boolean;
    getChanges(): {};
    [util.inspect.custom](): {};
}
export class Validator {
    constructor(data?: {}, id?: any, table?: any, rules?: {}, customMessages?: {}, db?: any);
    data: {};
    id: any;
    table: any;
    rules: {};
    customMessages: {};
    errorBag: {};
    primaryKey: string;
    db: any;
    fails(): Promise<boolean>;
    passes(): boolean;
    getErrors(): {};
    addError(field: any, message: any): void;
    msg(field: any, rule: any, fallback: any): any;
    toNumber(val: any): number;
    validateRequired(field: any): void;
    validateString(field: any): void;
    validateBoolean(field: any): void;
    validateNumeric(field: any): void;
    validateInteger(field: any): void;
    validateEmail(field: any): void;
    validateMin(field: any, min: any): void;
    validateMax(field: any, max: any): void;
    validateConfirmed(field: any): void;
    validateDate(field: any): void;
    validateUrl(field: any): void;
    validateIp(field: any): void;
    validateUuid(field: any): void;
    validateSlug(field: any): void;
    validateAfter(field: any, dateField: any): void;
    validateBefore(field: any, dateField: any): void;
    validateRegex(field: any, pattern: any): void;
    validateIn(field: any, ...values: any[]): void;
    validateNotIn(field: any, ...values: any[]): void;
    validateUnique(field: any, table?: any, column?: any, ignore?: any, pk?: any): Promise<void>;
    validateExists(field: any, table?: any, column?: any, whereColumn?: any, whereValue?: any): Promise<void>;
    validatePhone(field: any): void;
    validateAlpha(field: any): void;
    validateAlphaNum(field: any): void;
    validateArray(field: any): void;
    validateJson(field: any): void;
    validateBetween(field: any, min: any, max: any): void;
    validateFile(field: any): void;
    validateImage(field: any): void;
    validateMimes(field: any, types: any): void;
    validateSize(field: any, maxKB: any): void;
}
export class ValidationError extends Error {
    /**
     * Converts messages to a string suitable for web users
     */
    static formatMessages(messages: any): string;
    /**
     * @param {string | string[] | Record<string, any>} messages - Validation messages
     * @param {ErrorOptions} [options] - Optional error options
     */
    constructor(messages: string | string[] | Record<string, any>, options?: ErrorOptions);
    messages: string | string[] | Record<string, any>;
    status: number;
    code: string;
    get errors(): string;
    get [Symbol.toStringTag](): string;
}
export class Collection extends Array<any> {
    static make(items?: any[]): Collection;
    static range(start: any, end: any): Collection;
    constructor(items?: any[]);
    count(): number;
    isEmpty(): boolean;
    isNotEmpty(): boolean;
    first(): any;
    last(): any;
    nth(index: any): any;
    toArray(): this[number][];
    toJSON(): this[number][];
    clone(): Collection;
    each(fn: any): Promise<this>;
    mapAsync(fn: any): Promise<Collection>;
    where(key: any, value: any): Collection;
    whereNot(key: any, value: any): Collection;
    filterNull(): Collection;
    onlyKeys(keys: any): Collection;
    exceptKeys(keys: any): Collection;
    sortBy(key: any): Collection;
    sortByDesc(key: any): Collection;
    mapToArray(fn: any): any[];
    pluck(key: any): Collection;
    toObject(): any[];
    compact(): Collection;
    flatten(depth?: number): Collection;
    flattenDeep(): Collection;
    unique(fnOrKey?: any): Collection;
    sum(key?: any): any;
    avg(key?: any): number;
    max(key?: any): any;
    min(key?: any): any;
    groupBy(keyOrFn: any): {};
    random(n?: number): any;
    shuffle(): Collection;
    chunk(size: any): Collection;
    take(n: any): Collection;
    skip(n: any): Collection;
    find(fn: any): any;
    includesWhere(key: any, value: any): boolean;
    has(fn: any): boolean;
    intersect(otherCollection: any): Collection;
    diff(otherCollection: any): Collection;
    union(otherCollection: any): Collection;
    pipe(fn: any): any;
}
/******************************************************************************
 * QueryBuilder (Bug-Free)
 *****************************************************************************/
export class QueryBuilder {
    static fromJSON(json: any): QueryBuilder;
    constructor(table: any, modelClass?: any, dialect?: string);
    table: any;
    tableAlias: any;
    modelClass: any;
    _select: string[];
    _joins: any[];
    _wheres: any[];
    _group: any[];
    _having: any[];
    _orders: any[];
    _limit: number;
    _offset: number;
    _forUpdate: boolean;
    _distinct: boolean;
    dialect: string;
    _with: any[];
    _ignoreSoftDeletes: boolean;
    _ctes: any[];
    _unions: any[];
    _fromRaw: any;
    _normalizeOperator(operator: any): any;
    _isNumericId(value: any): boolean;
    /**************************************************************************
     * BASIC CONFIG
     **************************************************************************/
    alias(a: any): this;
    distinct(): this;
    /**************************************************************************
     * SELECT
     **************************************************************************/
    select(...cols: any[]): this;
    addSelect(...cols: any[]): this;
    /**************************************************************************
     * JOINS
     **************************************************************************/
    join(type: any, table: any, first: any, operator: any, second: any): this;
    innerJoin(t: any, f: any, o: any, s: any): this;
    leftJoin(t: any, f: any, o: any, s: any): this;
    rightJoin(t: any, f: any, o: any, s: any): this;
    crossJoin(t: any): this;
    find(value: any, options?: {}): Promise<any>;
    findOrFail(value: any, options?: {}): Promise<any>;
    /**************************************************************************
     * WHERE HELPERS
     **************************************************************************/
    _pushWhere(w: any): this;
    then(resolve: any, reject: any): Promise<Collection>;
    where(columnOrObject: any, operator: any, value: any, ...args: any[]): this;
    orWhere(columnOrObject: any, operatorOrValue: any, value: any, ...args: any[]): this;
    toSQL(): string;
    /**************************************************************************
     * TO SQL
     **************************************************************************/
    toSQL(): {
        sql: string;
        bindings: any[];
    };
    whereRaw(sql: any, bindings?: any[]): this;
    orWhereRaw(sql: any, bindings?: any[]): this;
    whereColumn(a: any, op: any, b: any, ...args: any[]): this;
    orWhereColumn(a: any, op: any, b: any, ...args: any[]): this;
    whereNested(cb: any): this;
    whereIn(column: any, values?: any[]): this;
    /** COMPLETELY FIXED VERSION */
    whereNot(column: any, operatorOrValue: any, value: any, ...args: any[]): this;
    whereNotIn(column: any, values?: any[]): this;
    whereNull(col: any): this;
    whereNotNull(col: any): this;
    whereBetween(col: any, [a, b]: [any, any]): this;
    whereNotBetween(col: any, [a, b]: [any, any]): this;
    whereExists(builderOrRaw: any): this;
    whereNotExists(builderOrRaw: any): this;
    _existsHelper(builderOrRaw: any, neg: any): this;
    /**************************************************************************
     * JSON
     **************************************************************************/
    whereJsonPath(column: any, path: any, operator: any, value: any, ...args: any[]): this;
    whereJsonContains(column: any, value: any): this;
    /**************************************************************************
     * GROUP / HAVING
     **************************************************************************/
    groupBy(...cols: any[]): this;
    having(column: any, operatorOrValue: any, value: any, ...args: any[]): this;
    orHaving(column: any, operatorOrValue: any, value: any, ...args: any[]): this;
    _pushHaving(column: any, op: any, value: any, bool: any): this;
    /**************************************************************************
     * ORDER / LIMIT
     **************************************************************************/
    orderBy(col: any, dir?: string): this;
    limit(n: any): this;
    offset(n: any): this;
    forUpdate(): this;
    /**************************************************************************
     * CTE
     **************************************************************************/
    withCTE(name: any, query: any, { recursive }?: {
        recursive?: boolean;
    }): this;
    /**************************************************************************
     * UNION
     **************************************************************************/
    union(q: any): this;
    unionAll(q: any): this;
    /**************************************************************************
     * RAW FROM
     **************************************************************************/
    fromRaw(raw: any): this;
    /**************************************************************************
     * WITH (Eager Load)
     **************************************************************************/
    with(relations: any): this;
    preload(relations: any): this;
    ignoreSoftDeletes(): this;
    whereHas(relationName: any, callback: any, boolean?: string): this;
    /**************************************************************************
     * COMPILERS
     **************************************************************************/
    _compileSelect(): string;
    _compileWheres(): string;
    _gatherBindings(): any[];
    /**************************************************************************
     * READ METHODS
     **************************************************************************/
    get(): Promise<Collection>;
    first(): Promise<any>;
    firstOrFail(): Promise<any>;
    exists(): Promise<boolean>;
    doesntExist(): Promise<boolean>;
    count(column?: string): Promise<number>;
    _aggregate(expr: any): Promise<number>;
    sum(c: any): Promise<number>;
    avg(c: any): Promise<number>;
    min(c: any): Promise<number>;
    max(c: any): Promise<number>;
    countDistinct(c: any): Promise<number>;
    pluck(col: any): Promise<any>;
    paginate(page?: number, perPage?: number): Promise<Paginator>;
    /**************************************************************************
     * WRITE METHODS
     **************************************************************************/
    insert(values: any): Promise<any>;
    insertGetId(values: any): Promise<any>;
    update(values: any): Promise<any>;
    increment(col: any, by?: number): Promise<any>;
    decrement(col: any, by?: number): Promise<any>;
    delete(): Promise<any>;
    truncate(): Promise<boolean>;
    _compileWhereOnly(): string;
    /**************************************************************************
     * EAGER LOAD (unchanged except robust checks)
     **************************************************************************/
    _eagerLoad(models: any): Promise<any>;
    /**************************************************************************
     * CLONE
     **************************************************************************/
    _clone(): QueryBuilder;
    _rehydrateWheres(ws: any): any;
    _rehydrateCTEs(ctes: any): any;
    _rehydrateUnions(unions: any): any;
    toJSON(): {
        table: any;
        tableAlias: any;
        modelClass: any;
        dialect: string;
        select: string[];
        joins: any[];
        wheres: any[];
        group: any[];
        having: any[];
        orders: any[];
        limit: number;
        offset: number;
        distinct: boolean;
        forUpdate: boolean;
        with: any[];
        ignoreSoftDeletes: boolean;
        ctes: {
            name: any;
            recursive: any;
            query: any;
        }[];
        unions: {
            type: any;
            query: any;
        }[];
        fromRaw: any;
    };
    toSQLJSON(): {
        sql: string;
        bindings: any[];
    };
    toSQLWhereOnly(): {
        sql: string;
        bindings: any[];
    };
}
export class HasMany extends Relation {
    get(): Promise<any>;
    eagerLoad(parents: any, relName: any): Promise<void>;
}
export class HasOne extends Relation {
    get(): Promise<any>;
    eagerLoad(parents: any, relName: any): Promise<void>;
}
export class BelongsTo extends Relation {
    ownerKey: any;
    get(): Promise<any>;
    eagerLoad(parents: any, relName: any): Promise<void>;
}
export class BelongsToMany extends Relation {
    constructor(parent: any, relatedClass: any, pivotTable?: any, foreignKey?: any, relatedKey?: any);
    pivotTable: any;
    relatedKey: any;
    parentPK: any;
    relatedPK: any;
    _pivotColumns: any[];
    _withTimestamps: boolean;
    _pivotOrder: {
        column: any;
        direction: string;
    };
    withPivot(...columns: any[]): this;
    withTimestamps(): this;
    orderByPivot(column: any, direction?: string): this;
    get(): Promise<any>;
    eagerLoad(parents: any, relName: any): Promise<void>;
    attach(ids: any, pivotData?: {}): Promise<any>;
    detach(ids?: any): Promise<any>;
    sync(ids: any): Promise<{
        attached: any;
        detached: any[];
    }>;
    toggle(ids: any): Promise<{
        attached: any;
        detached: any;
    }>;
    _hydratePivot(rows: any): any;
}
export class DBError extends Error {
    constructor(message: any, meta?: {});
    meta: {};
}
export class BaseModel extends Model {
    static passwordField: string;
    static hashRounds: number;
    /**
     * Lifecycle hook placeholders
     * Subclasses can override these.
     */
    beforeCreate(attrs: any): Promise<void>;
    afterCreate(savedRecord: any): Promise<void>;
    beforeSave(attrs: any): Promise<void>;
    afterSave(savedRecord: any): Promise<void>;
    /**
     * Called when inserting a new record.
     */
    saveNew(attrs: any): Promise<this>;
    /**
     * Called when updating an existing record.
     */
    save(): Promise<this>;
    /**
     * Hash password field if needed.
     */
    _maybeHashPassword(attrs: any): Promise<void>;
    /**
     * Check a plain text password against the hashed one.
     */
    checkPassword(rawPassword: any): Promise<any>;
    /**
     * Serialize model data for output.
     * Override this to customize output (e.g. hide sensitive fields).
     */
    serialize(): {};
}
declare class SimpleCache {
    map: Map<any, any>;
    get(k: any): any;
    set(k: any, v: any, ttl?: number): void;
    del(k: any): void;
    clear(): void;
}
declare class HasManyThrough extends Relation {
    constructor(parent: any, relatedClass: any, throughClass: any, firstKey: any, secondKey: any, localKey: any, secondLocalKey: any);
    throughClass: any;
    firstKey: any;
    secondKey: any;
    secondLocalKey: any;
    get(): Promise<any>;
}
declare class MorphOne extends Relation {
    morphType: string;
    get(): Promise<any>;
}
declare class MorphMany extends Relation {
    morphType: string;
    get(): Promise<any>;
}
declare class MorphTo {
    constructor(parent: any, typeField?: string, idField?: string);
    parent: any;
    typeField: string;
    idField: string;
    get(): Promise<any>;
}
declare class MorphToMany extends Relation {
    constructor(parent: any, relatedClass: any, morphName: any, pivotTable?: any, foreignKey?: any, relatedKey?: any);
    morphTypeColumn: string;
    pivotTable: any;
    relatedKey: any;
}
declare class MorphedByMany extends MorphToMany {
}
import util = require("util");
declare class Paginator {
    constructor(data: any, total: any, page: any, perPage: any);
    data: any;
    total: number;
    page: number;
    perPage: number;
    lastPage: number;
    _dataToArray(): any;
    toJSON(): {
        data: any;
        total: number;
        page: number;
        perPage: number;
        lastPage: number;
    };
}
declare class Relation {
    constructor(parent: any, relatedClass: any, foreignKey?: any, localKey?: any);
    parent: any;
    relatedClass: any;
    foreignKey: any;
    localKey: any;
    deleteBehavior: any;
    onDelete(behavior: any): this;
}
export {};

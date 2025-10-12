#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const DB = require('./models/lib/model');
const args = process.argv.slice(2);

const MIGRATIONS_DIR = './database/migrations';
const MIGRATIONS_TABLE = 'migrations';
const SEEDERS_DIR = './database/seeders';
const SEEDS_TABLE = 'seeds';

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

// ------------------ SCHEMA BUILDER (Knex-like) ------------------

DB.schema = {
  createTable: async (tableName, callback) => {
    const columns = [];
    const table = {
      increments: (name) => columns.push(`\`${name}\` INT AUTO_INCREMENT PRIMARY KEY`),
      string: (name) => columns.push(`\`${name}\` VARCHAR(255)`),
      integer: (name) => columns.push(`\`${name}\` INT`),
      boolean: (name) => columns.push(`\`${name}\` TINYINT(1)`),
      text: (name) => columns.push(`\`${name}\` TEXT`),
      float: (name) => columns.push(`\`${name}\` FLOAT`),
      decimal: (name) => columns.push(`\`${name}\` DECIMAL(10,2)`),
      date: (name) => columns.push(`\`${name}\` DATE`),
      dateTime: (name) => columns.push(`\`${name}\` DATETIME`),
      json: (name) => columns.push(`\`${name}\` JSON`),
      binary: (name) => columns.push(`\`${name}\` BLOB`),
      timestamps: () => {
        columns.push('`created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        columns.push('`updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
      }
    };
    await callback(table);
    const sql = `CREATE TABLE \`${tableName}\` (\n  ${columns.join(',\n  ')}\n)`;
    return await DB.raw(sql);
  },
  dropTableIfExists: async (tableName) => {
    return await DB.raw(`DROP TABLE IF EXISTS \`${tableName}\``);
  }
};

// ------------------ MIGRATION GENERATE ------------------

function parseFields(fieldArgs) {
  const typeMap = {
    string: 'string',
    integer: 'integer',
    boolean: 'boolean',
    text: 'text',
    date: 'date',
    datetime: 'dateTime',
    float: 'float',
    decimal: 'decimal',
    json: 'json',
    binary: 'binary'
  };

  return fieldArgs.map(arg => {
    const [name, type] = arg.split(':');
    const fn = typeMap[type];
    if (!name || !fn) throw new Error(`Invalid field: ${arg}`);
    return `table.${fn}('${name}');`;
  });
}

function generateMigration(table, fields) {
  const timestamp = getTimestamp();
  const fileName = `${timestamp}_create_${table}_table.js`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);

  const content = `
// Migration: Create ${table} table

module.exports = {
  up: async function (db) {
    await db.schema.createTable('${table}', (table) => {
      table.increments('id');
      ${fields.map(f => `      ${f}`).join('\n')}
      table.timestamps();
    });
  },

  down: async function (db) {
    await db.schema.dropTableIfExists('${table}');
  }
};
`;

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(filePath, content.trimStart());
  console.log(`✅ Migration generated: ${filePath}`);
}

// ------------------ MIGRATIONS: UP / ROLLBACK ------------------

async function ensureMigrationsTable() {
  await DB.raw(`CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  const rows = await DB.raw(`SELECT name FROM \`${MIGRATIONS_TABLE}\``);
  return new Set(rows.map(r => r.name));
}

async function runMigrations() {
  DB.initFromEnv();
  await DB.connect();

  const applied = await getAppliedMigrations();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js')).sort();
  const toRun = files.filter(f => !applied.has(f));

  for (const file of toRun) {
    const migration = require(path.resolve(MIGRATIONS_DIR, file));
    console.log(`⏳ Running migration: ${file}`);
    await migration.up(DB);
    await DB.raw(`INSERT INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`, [file]);
    console.log(`✅ Applied: ${file}`);
  }

  await DB.end();
}

async function rollbackLastMigration() {
  DB.initFromEnv();
  await DB.connect();

  const [last] = await DB.raw(`SELECT name FROM \`${MIGRATIONS_TABLE}\` ORDER BY run_at DESC LIMIT 1`);
  if (!last) {
    console.log('ℹ️ No migrations to rollback.');
    return;
  }

  const file = last.name;
  const migration = require(path.resolve(MIGRATIONS_DIR, file));
  console.log(`⏳ Rolling back: ${file}`);
  await migration.down(DB);
  await DB.raw(`DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE name = ?`, [file]);
  console.log(`✅ Rolled back: ${file}`);

  await DB.end();
}

// ------------------ SEEDERS ------------------

function generateSeeder(name) {
  const timestamp = getTimestamp();
  const fileName = `${timestamp}_${name}.js`;
  const filePath = path.join(SEEDERS_DIR, fileName);

  const content = `
// Seeder: ${name}

module.exports = {
  seed: async function (db) {
    // Example:
    // await db.raw("INSERT INTO users (name) VALUES (?)", ['Example']);
  }
};
`;

  fs.mkdirSync(SEEDERS_DIR, { recursive: true });
  fs.writeFileSync(filePath, content.trimStart());
  console.log(`✅ Seeder generated: ${filePath}`);
}

async function ensureSeedsTable() {
  await DB.raw(`CREATE TABLE IF NOT EXISTS \`${SEEDS_TABLE}\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function getAppliedSeeds() {
  const rows = await DB.raw(`SELECT name FROM \`${SEEDS_TABLE}\``);
  return new Set(rows.map(r => r.name));
}

async function runSeeders({ refresh = false, only = null } = {}) {
  DB.initFromEnv();
  await DB.connect();
  await ensureSeedsTable();

  const files = fs.readdirSync(SEEDERS_DIR).filter(f => f.endsWith('.js')).sort();
  let targets = files;

  if (only) {
    if (!files.includes(only)) {
      console.error(`❌ Seed file not found: ${only}`);
      await DB.end();
      return;
    }
    targets = [only];
  }

  if (refresh) {
    await DB.raw(`DELETE FROM \`${SEEDS_TABLE}\``);
    console.log(`🔁 Refreshing all seeds...`);
  } else {
    const applied = await getAppliedSeeds();
    targets = targets.filter(f => !applied.has(f));
  }

  if (!targets.length) {
    console.log('✅ No seeders to run.');
    await DB.end();
    return;
  }

  for (const file of targets) {
    const seeder = require(path.resolve(SEEDERS_DIR, file));
    if (typeof seeder.seed !== 'function') {
      console.warn(`⚠️ Skipping invalid seeder: ${file}`);
      continue;
    }

    try {
      console.log(`🌱 Running seeder: ${file}`);
      await seeder.seed(DB);
      await DB.raw(`INSERT INTO \`${SEEDS_TABLE}\` (name) VALUES (?)`, [file]);
      console.log(`✅ Seeded: ${file}`);
    } catch (err) {
      console.error(`❌ Seeder failed: ${file}\n`, err);
      break;
    }
  }

  await DB.end();
}

// ------------------ MODEL GENERATOR ------------------

function generateModel(name, fieldArgs = []) {
  try {
    if (!name || typeof name !== 'string') {
      console.error('❌ Invalid model name.');
      process.exit(1);
    }

    const modelDir = './models';
    fs.mkdirSync(modelDir, { recursive: true });

    // Extract optional --table argument
    let tableName = name.toLowerCase() + 's';
    const tableOptionIndex = fieldArgs.findIndex(arg => arg.startsWith('--table='));
    if (tableOptionIndex !== -1) {
      const tableOption = fieldArgs[tableOptionIndex];
      const parts = tableOption.split('=');
      if (parts.length < 2 || !parts[1]) {
        console.error('❌ Invalid --table option. Usage: --table=table_name');
        process.exit(1);
      }
      tableName = parts[1];
      fieldArgs.splice(tableOptionIndex, 1); // remove --table option
    }

    // Extract field names (for fillable)
    const fields = fieldArgs
      .filter(arg => arg.includes(':'))
      .map(arg => arg.split(':')[0].trim())
      .filter(Boolean);

    const fillableArray = fields.length ? `['${fields.join("', '")}']` : `[]`;
    const className = name.charAt(0).toUpperCase() + name.slice(1);
    const filePath = path.join(modelDir, `${className}.js`);

    const content = `
// ${className} Model
const { Model, DB } = require('./lib/model');

DB.initFromEnv({ debug: true });

class ${className} extends Model {
  static table = '${tableName}';
  static primaryKey = 'id';
  static autoIncrement = true;
  static timestamps = true;
  static fillable = ${fillableArray};
}

module.exports = ${className};
`;

    fs.writeFileSync(filePath, content.trimStart());
    console.log(`✅ Model generated successfully: ${filePath}`);
  } catch (err) {
    console.error('❌ Failed to generate model:', err.message);
    process.exit(1);
  }
}


// ------------------ CLI HANDLER ------------------

(async () => {
  const command = args[0];

  switch (command) {
    case 'generate':
      const table = args[1];
      const fields = args.slice(2);
      if (!table || fields.length === 0) {
        console.error('❌ Usage: generate <table> <field:type>...');
        process.exit(1);
      }
      generateMigration(table, parseFields(fields));
      break;

    case 'up':
      await runMigrations();
      break;

    case 'rollback':
      await rollbackLastMigration();
      break;

    case 'seed:generate':
      const seedName = args[1];
      if (!seedName) {
        console.error('❌ Usage: seed:generate <name>');
        process.exit(1);
      }
      generateSeeder(seedName);
      break;

    case 'seed':
      await runSeeders();
      break;

    case 'seed:refresh':
      await runSeeders({ refresh: true });
      break;

    case 'seed:only':
      const onlySeed = args[1];
      if (!onlySeed) {
        console.error('❌ Usage: seed:only <filename.js>');
        process.exit(1);
      }
      await runSeeders({ only: onlySeed });
      break;

    case 'model': {
      const modelName = args[1];
      const modelFields = args.slice(2);

      if (!modelName) {
        console.error('❌ Usage: model <ModelName> [field:type ...] [--table=table_name]');
        process.exit(1);
      }

      generateModel(modelName, modelFields);
      break;
    }

    default:
      console.log(`
📦 CLI Migration & Seeder Tool

Usage:
  node migrate.js generate <table> <field:type>...
  node migrate.js up
  node migrate.js rollback

  node migrate.js seed:generate <name>
  node migrate.js seed
  node migrate.js seed:refresh
  node migrate.js seed:only 20251008_users_seed.js
  node migrate.js model User
  node migrate.js model Product name:string price:decimal stock:integer


      `);
  }
})();

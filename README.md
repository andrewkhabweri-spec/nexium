# Migration & Seeder CLI Tool
This package is a modular version of the Nexium ORM. It supports MySQL (mysql2), PostgreSQL (pg), and SQLite (sqlite3).
A simple Node.js CLI for generating and running database migrations and seeders with MySQL, using a custom DB wrapper.

---
get all Usage in examples provided for any issue or support get in tourch @ `andrewkhabweri@gmail.com`
## Features

- Generate migration files dynamically with fields
- Run migrations (`up`)
- Rollback last migration
- Generate seed files dynamically
- Run all unapplied seeders
- Refresh all seeds (rollback + rerun)
- Run specific seed files
- Built-in schema builder 

---

## Prerequisites

- Node.js (v14+ recommended)
- MySQL database
- `.env` file configured with your database credentials (see example below)

---

## Setup

1. download this project.
npm i nexium-orm

2. Install dependencies (if any).  
   > This tool uses `mysql2`,`pg`,`sqlite3` driver, so make sure you install it:
 Configure DB via environment variables: `'DB_CONNECTION=mysql',DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`,`DEBUG=true`.
 
## Quick start
for database connection use any driver of your choice eg
`DB_CONNECTION=mysql` # if using mysql2
`DB_CONNECTION=pg` # if using PostgreSQL
`DB_CONNECTION=sqlite` # for sqlite

`DEBUG=true` # set to false in Production
`DB_DATABASE=./database.sqlite`   # if using sqlite
1. Install dependencies:
   ```
   npm install
   ```
```bash
npm i nexium-orm

npm install mysql2 dotenv bcrypt

```bash
#Make Sure you put this in package.json inside your project directory for CLI generating and running database migrations Model generate and seeders to work

"scripts": {
  "artisan": "node ./node_modules/nexium-orm/artisan.js"
}


# create User Migration without fields
npm run artisan -- generate users
# Or create User Migration with fields
npm run artisan -- generate users name:string email:string active:boolean
# Migrate all Migrations
npm run artisan -- up
# rollback Migrations
npm run artisan -- rollback
# run seeders
npm run artisan -- seed:generate users_seed
npm run artisan -- seed
npm run artisan -- seed:refresh
npm run artisan -- seed:only 20251008_users_seed.js
# create Model without fields
npm run artisan -- model User
# or if you want to create Model with fields
npm run artisan -- model Product name:string price:decimal stock:integer

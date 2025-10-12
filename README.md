# Nexium ORM v4.1 (JavaScript)

Lightweight, Laravel-inspired ORM for Node.js.

## Install

```bash
npm install mysql2
# copy nexium-orm v4.1 into your project
```

## Quickstart

See `examples/simple.js` for a basic example. Configure DB via environment variables: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`.

## API

- `DB` - low-level DB helper
- `BaseModel` - base model class
- `QueryBuilder` - build queries and aggregates (`sum`, `avg`, `min`, `max`)
- `Validator` - validation with rules including `password`, `regex`, `size`, `unique`

## License
MIT

// controllers/UserController.js
const User = require('Model-User');
const { validate } = require('nexium-orm');

class UserController {
  // GET /users
  async index(req, res) {
    try {
      const users = await User.query().get();
      return res.json(users);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch users.' });
    }
  }

  // GET /users/:id
  async show(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      return res.json(user);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch user.' });
    }
  }

  // POST /users
  static async store(req, res) {
    // 1. Extract input
    const input = {
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      phone: req.body.phone, // ✅ optional field
      status: req.body.status,
    };

    // 2. Define validation rules
    const rules = {
      name: ['required', 'min:3'],
      email: ['required', 'email'],
      password: ['required', 'min:6'],     
      phone: [(v) => v == null || /^[0-9]{10,15}$/.test(v)], // ✅ optional phone validation
      status: [(v) => v == null || v === 'true' || v === 'false'], // custom boolean-like validation
    };

    // 3. Run validation
    const { valid, errors } = validate(input, rules);

    if (!valid) {
      return res.status(400).json({
        message: 'Validation failed',
        errors,
      });
    }

    try {
      // 4. Create user if valid
      await User.create({
        name: input.name,
        email: input.email,
        password: input.password,
        phone: input.phone,
        status: input.status === 'true',
      });

      res.redirect('/users');
    } catch (err) {
      console.error('Error creating user:', err);
      res.status(500).send('Internal Server Error');
    }
  }

  // PUT /users/:id
  async update(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.fill(req.body);
      await user.save();

      return res.json(user);
    } catch (err) {
      return res.status(400).json({ error: 'Failed to update user.' });
    }
  }

  // DELETE /users/:id
  async destroy(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.delete();
      return res.status(204).send(); // No Content
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete user.' });
    }
  }

  // POST /users/:id/restore
  async restore(req, res) {
    try {
      const user = await User.withTrashed().where('id', req.params.id).first();
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.restore();
      return res.json(user);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to restore user.' });
    }
  }
}

module.exports = new UserController();

//Basic CRUD & Query

const User = require('./models/User');

// Create new user
const user = await User.create({ name: 'Alice', email: 'alice@example.com', password: 'secret' });

// Fill & save (update)
user.name = 'Alice Smith';  // you can also use user.fill({ name: 'Alice Smith' })
await user.save();

// Find by primary key
const user2 = await User.find(1);

// Query with where
const someUsers = await User.where('email', 'alice@example.com').get();

// First match
const firstUser = await User.where('name', 'Alice').first();

const user = await User.findBy('email', 'jane@example.com');

const isValid = await user.checkPassword('user_input_password');
// Delete (soft delete if enabled)
await user.delete();

// Restore (if softDeletes enabled)
await user.restore();

// List all (excluding trashed, by default)
const allUsers = await User.all();

// Query including soft-deleted (trashed) records
const withTrashed = await User.withTrashed().where('id', 1).first();

//QueryBuilder Advanced Features

const qb = User.query();

// Select specific columns
const names = await User.query().select('id', 'name').get();

// Aggregates
const cnt = await User.query().count();          // count(*)
const sumId = await User.query().sum('id');
const avgId = await User.query().avg('id');
const minId = await User.query().min('id');
const maxId = await User.query().max('id');

// Pluck a column (returns array of values)
const emails = await User.query().pluck('email');

// Pagination
const page1 = await User.query().paginate(1, 10);
// page1 = { total, perPage, page, lastPage, data: [users...] }

// Where In
const usersIn = await User.query().whereIn('id', [1, 2, 3]).get();

// Where Null / Not Null
const withNull = await User.query().whereNull('deleted_at').get();
const notNull = await User.query().whereNotNull('deleted_at').get();

// Where Between
const inRange = await User.query().whereBetween('id', [10, 20]).get();

// Ordering, grouping, having
const grouped = await User.query()
  .select('user_id', 'COUNT(*) as cnt')
  .groupBy('user_id')
  .having('cnt', '>', 1)
  .get();

// Joins
const withPosts = await User.query()
  .select('users.*', 'posts.title as post_title')
  .join('INNER', 'posts', 'users.id', '=', 'posts.user_id')
  .get();

// Using “forUpdate” (locking)
await User.query().where('id', 5).forUpdate().get();

// Raw queries
const rows = await User.raw('SELECT * FROM users WHERE id = ?', [5]);

// Caching
const cachedRows = await User.raw('SELECT * FROM users', []).then(rows => rows);
const cached = await DB.cached('SELECT * FROM users WHERE id = ?', [5], 60000);

//You can use relations:

const user = await User.find(1);
const posts = await user.posts().get();  // all posts for the user

// Eager load in a query:
const usersWithPosts = await User.query().with('posts').get();
// Each user will have a `posts` field with array of post models.

// Many-to-many example
// Suppose you have an intermediate pivot table user_roles (user_id, role_id)
// and models User and Role, with pivot user_roles.
//

// Then:
const user = await User.find(2);
const roles = await user.roles().get();
await user.roles().attach(5);
await user.roles().detach(3);

// Eager load:
const usersWithRoles = await User.query().with('roles').get();

//Events / Hooks

User.on('creating', async (usr) => {
  // e.g. hash password before insert
  if (usr.password) {
    usr.password = hash(usr.password);
  }
});

User.on('updating', async (usr) => {
  // e.g. prevent email change in certain cases
  if (usr.email && usr._original.email !== usr.email) {
    // validate or block
  }
});

User.on('deleting', async (usr) => {
  // e.g. cleanup related data, soft delete constraints
});


// models/User.js
const { BaseModel, Model , DB, HasMany, HasOne, BelongsTo, BelongsToMany, validate } = require('nexium-orm');// you can call Any of these class to use them

class User extends BaseModel {
  static table = 'users';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = true;// Optional if you don't need it
  static fillable = ['name', 'email', 'password'];// password is Auto encrypted when creating.

  
  // Many-to-many: User ↔ Role via pivot user_roles (user_id, role_id)
  roles() {
    return this.belongsToMany(
      require('./Role'),
      'user_roles',
      'user_id',
      'role_id',
      'id',
      'id'
    );
  }

  // One-to-many: User -> Post
  posts() {
    return this.hasMany(require('./Post'), 'user_id', 'id');
  }
}

module.exports = User;

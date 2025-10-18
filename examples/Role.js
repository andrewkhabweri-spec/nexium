const { BaseModel, DB } = require('nexium-orm');

class Role extends BaseModel {
  static table = 'roles';
  static primaryKey = 'id';
  static timestamps = false;
  static softDeletes = false;// Optional if you don't need it
  static fillable = ['name'];

  users() {
    return this.belongsToMany(
      require('./User'),
      'user_roles',
      'role_id',
      'user_id',
      'id',
      'id'
    );
  }
}

module.exports = Role;

const { BaseModel } = require('nexium-orm');

class Post extends BaseModel {
  static table = 'posts';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = true;// Optional if you don't need it
  static fillable = ['title', 'body', 'user_id'];

  user() {
    return this.belongsTo(require('./User'), 'user_id', 'id');
  }
}

module.exports = Post;

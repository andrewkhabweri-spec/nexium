// examples/simple.js
const { DB, Model } = require('nexium-orm');
// Example User model
class User extends Model {
  static table = 'users';
  static casts = { id: 'integer' };
  static rules = { email: 'required|email|unique:users,email', password: 'required|password' };
}
async function demo(){
  DB.initFromEnv({debug:true});
  // create a user (will validate)
  try {
    const u = await User.create({ email: 'test@example.com', password: 'P@ssw0rd!' });
    console.log('Created user id', u.id);
  } catch(e){
    console.error('Validation error', e.errors);
  } finally {
    await DB.end();
  }
}
if(require.main === module) demo();

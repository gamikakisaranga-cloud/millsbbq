const mysql = require('mysql2/promise');

// A single shared connection pool for the whole app.
// DATABASE_URL format: mysql://user:password@host:3306/database_name
const pool = mysql.createPool(process.env.DATABASE_URL);

module.exports = pool;

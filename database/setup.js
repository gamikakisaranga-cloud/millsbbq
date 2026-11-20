// Applies database/schema.sql against the database in DATABASE_URL.
// Usage: npm run db:setup
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to your .env file first.');
    process.exit(1);
  }
  const files = ['schema.sql', 'migrations/002_erp.sql', 'migrations/003_customer_marketing_recipes.sql'];
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    // multipleStatements isn't enabled on the pooled connection string by default,
    // so run each CREATE TABLE statement separately.
    let total = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const statements = sql.split(/;\s*\n/).map(statement => statement.trim()).filter(Boolean);
      for (const statement of statements) {
        try { await connection.query(statement); }
        catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_KEYNAME') throw error; }
      }
      total += statements.length;
      console.log(`Applied ${statements.length} statements from ${file}.`);
    }
    await connection.query('ALTER TABLE orders MODIFY payment_provider VARCHAR(20) NULL');
    await connection.query('ALTER TABLE payments MODIFY provider VARCHAR(20) NOT NULL');
    console.log(`Database setup complete (${total} statements).`);
  } finally {
    await connection.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

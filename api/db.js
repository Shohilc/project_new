require('dotenv').config();
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
let isPostgres = false;
let pgPool = null;
let sqliteDb = null;

// Determine directory for SQLite
const DATA_DIR = process.env.VERCEL 
  ? '/tmp' 
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const sqlitePath = path.join(DATA_DIR, 'responses.db');

async function init() {
  if (connectionString) {
    console.log("Initializing PostgreSQL database client...");
    try {
      pgPool = new Pool({
        connectionString,
        ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
          ? false
          : { rejectUnauthorized: false }
      });
      // Test the connection
      await pgPool.query('SELECT NOW()');
      isPostgres = true;
      console.log("PostgreSQL connection successful.");
    } catch (err) {
      console.error("PostgreSQL connection failed, falling back to local SQLite:", err.message);
      pgPool = null;
    }
  }

  if (!isPostgres) {
    console.log(`Initializing SQLite database at: ${sqlitePath}`);
    sqliteDb = new sqlite3.Database(sqlitePath);
  }

  // Create table if not exists
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS responses (
      id VARCHAR(50) PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      answers TEXT NOT NULL
    )
  `;

  await query(createTableQuery);
  console.log("Database schema checked/created successfully.");
}

async function query(text, params) {
  if (isPostgres && pgPool) {
    const res = await pgPool.query(text, params);
    return res;
  } else {
    // Convert SQLite query to match PG parameterized query style ($1, $2, etc. -> ?, ?, etc.)
    const sqliteText = text.replace(/\$\d+/g, '?');
    
    return new Promise((resolve, reject) => {
      const isSelect = sqliteText.trim().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        sqliteDb.all(sqliteText, params || [], (err, rows) => {
          if (err) return reject(err);
          resolve({ rows });
        });
      } else {
        sqliteDb.run(sqliteText, params || [], function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID, changes: this.changes });
        });
      }
    });
  }
}

async function saveResponse(id, timestamp, answers) {
  const answersStr = JSON.stringify(answers);
  await query(
    `INSERT INTO responses (id, timestamp, answers) VALUES ($1, $2, $3)`,
    [id, timestamp, answersStr]
  );
}

async function getResponses() {
  const result = await query(`SELECT id, timestamp, answers FROM responses ORDER BY timestamp DESC`);
  return result.rows.map(row => ({
    id: row.id,
    timestamp: parseInt(row.timestamp),
    answers: JSON.parse(row.answers)
  }));
}
async function deleteResponse(id) {
  await query(`DELETE FROM responses WHERE id = $1`, [id]);
}

module.exports = {
  init,
  query,
  saveResponse,
  getResponses,
  deleteResponse,
  isPostgres: () => isPostgres,
  getDbInfo: () => ({
    type: isPostgres ? 'PostgreSQL' : 'SQLite',
    path: isPostgres ? null : sqlitePath,
    connected: isPostgres ? !!pgPool : !!sqliteDb
  })
};

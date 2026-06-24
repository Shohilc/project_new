require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const connectionString = process.env.DATABASE_URL || process.env.MYSQL_URL;
const mysqlHost = process.env.MYSQLHOST || process.env.MYSQL_HOST;
const mysqlUser = process.env.MYSQLUSER || process.env.MYSQL_USER;
const mysqlPassword = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD;
const mysqlDatabase = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;
const mysqlPort = process.env.MYSQLPORT || process.env.MYSQL_PORT;

let isMySQL = false;
let mysqlPool = null;
let sqliteDb = null;
let isSqlSupported = true;

// Determine directory for SQLite
const DATA_DIR = process.env.VERCEL 
  ? '/tmp' 
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const sqlitePath = path.join(DATA_DIR, 'responses.db');

async function init() {
  const hasMySQLConfig = connectionString || (mysqlHost && mysqlUser);
  
  if (hasMySQLConfig) {
    console.log("Initializing MySQL database pool...");
    try {
      if (connectionString) {
        const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
        const poolConfig = {
          uri: connectionString,
          waitForConnections: true,
          connectionLimit: 5,
          queueLimit: 0
        };
        if (!isLocal) {
          poolConfig.ssl = { rejectUnauthorized: false };
        }
        mysqlPool = mysql.createPool(poolConfig);
      } else {
        const poolConfig = {
          host: mysqlHost,
          user: mysqlUser,
          password: mysqlPassword,
          database: mysqlDatabase,
          port: mysqlPort ? parseInt(mysqlPort) : 3306,
          waitForConnections: true,
          connectionLimit: 5,
          queueLimit: 0
        };
        const isLocal = mysqlHost.includes('localhost') || mysqlHost.includes('127.0.0.1');
        if (!isLocal) {
          poolConfig.ssl = { rejectUnauthorized: false };
        }
        mysqlPool = mysql.createPool(poolConfig);
      }
      
      // Test the connection
      await mysqlPool.execute('SELECT 1');
      isMySQL = true;
      console.log("MySQL connection successful.");
    } catch (err) {
      console.error("MySQL connection failed, falling back to SQLite:", err.message);
      mysqlPool = null;
    }
  }

  if (!isMySQL) {
    if (process.env.VERCEL) {
      console.warn("Vercel environment detected without MySQL configuration. SQLite is not supported in serverless containers. Falling back to local files.");
      isSqlSupported = false;
    } else {
      try {
        console.log(`Initializing SQLite database at: ${sqlitePath}`);
        const sqlite3 = require('sqlite3');
        sqliteDb = new sqlite3.Database(sqlitePath);
      } catch (err) {
        console.error("Failed to initialize SQLite client:", err.message);
        isSqlSupported = false;
      }
    }
  }

  if (isSqlSupported) {
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
}

async function query(text, params) {
  if (!isSqlSupported) {
    throw new Error("SQL database is not supported or initialized in this environment.");
  }

  if (isMySQL && mysqlPool) {
    const [rows] = await mysqlPool.execute(text, params || []);
    return { rows };
  } else if (sqliteDb) {
    return new Promise((resolve, reject) => {
      const isSelect = text.trim().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        sqliteDb.all(text, params || [], (err, rows) => {
          if (err) return reject(err);
          resolve({ rows });
        });
      } else {
        sqliteDb.run(text, params || [], function(err) {
          if (err) return reject(err);
          resolve({ rows: [], lastID: this.lastID, changes: this.changes });
        });
      }
    });
  } else {
    throw new Error("No database client initialized.");
  }
}

async function saveResponse(id, timestamp, answers) {
  const answersStr = JSON.stringify(answers);
  await query(
    `INSERT INTO responses (id, timestamp, answers) VALUES (?, ?, ?)`,
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
  await query(`DELETE FROM responses WHERE id = ?`, [id]);
}

module.exports = {
  init,
  query,
  saveResponse,
  getResponses,
  deleteResponse,
  isPostgres: () => isMySQL, // Kept for backend status compatibility name
  getDbInfo: () => ({
    type: isMySQL ? 'MySQL' : (isSqlSupported ? 'SQLite' : 'None'),
    path: isMySQL ? null : (isSqlSupported ? sqlitePath : null),
    connected: isMySQL ? !!mysqlPool : (isSqlSupported ? !!sqliteDb : false)
  })
};

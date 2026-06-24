require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Initialize database
db.init().then(() => {
  console.log("Database initialized successfully.");
}).catch(err => {
  console.error("Database initialization failed:", err.message);
});

const app = express();
const PORT = process.env.PORT || 3000;
// Use /tmp for serverless container storage to avoid read-only EROFS errors on Vercel
const DATA_DIR = process.env.VERCEL 
  ? '/tmp' 
  : path.join(__dirname, '..', 'data');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Ensure local data directory exists for backups
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helpers
function saveLocalResponse(fileName, contentString) {
  try {
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, contentString, 'utf8');
    console.log(`Saved local response backup: ${fileName}`);
    return true;
  } catch (err) {
    console.error(`Failed to save local response ${fileName}:`, err.message);
    return false;
  }
}

function fetchLocalResponses() {
  try {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR);
    const responses = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        try {
          const filePath = path.join(DATA_DIR, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          return JSON.parse(raw);
        } catch (e) {
          console.error(`Error reading local file ${file}:`, e.message);
          return null;
        }
      });
    return responses.filter(r => r !== null);
  } catch (err) {
    console.error("Failed to read local responses folder:", err.message);
    return [];
  }
}

// ── API ENDPOINTS ──

// Check connection status
app.get('/api/status', async (req, res) => {
  const dbInfo = db.getDbInfo();
  
  res.json({
    localCount: fetchLocalResponses().length,
    isVercel: !!process.env.VERCEL,
    dbType: dbInfo.type,
    dbConnected: dbInfo.connected,
    dbPath: dbInfo.path
  });
});

// Submit responses
app.post('/api/responses', async (req, res) => {
  const { answers } = req.body;
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: "Invalid data format. Expected an array of answers." });
  }

  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 11);
  const responseId = `${timestamp}-${randomId}`;
  const fileName = `response-${responseId}.json`;
  
  const responseData = {
    id: responseId,
    timestamp,
    answers
  };

  const contentString = JSON.stringify(responseData, null, 2);
  
  // 1. Save to SQL database
  let sqlSaved = false;
  try {
    await db.saveResponse(responseId, timestamp, answers);
    sqlSaved = true;
  } catch (err) {
    console.error("Failed to save response to SQL database:", err.message);
  }
  
  // 2. Save local backup file
  const localSaved = saveLocalResponse(fileName, contentString);

  res.json({
    success: true,
    id: responseId,
    sqlSaved,
    localSaved
  });
});

// Get all responses (admin dashboard)
app.get('/api/responses', async (req, res) => {
  let responses = null;
  let isFromCloud = false;
  let isFromSql = false;
  
  try {
    responses = await db.getResponses();
    isFromSql = true;
    isFromCloud = db.isPostgres();
  } catch (err) {
    console.error("Failed to fetch responses from SQL database:", err.message);
  }
  
  if (responses === null) {
    console.log("SQL responses not available, falling back to local files.");
    responses = fetchLocalResponses();
    isFromCloud = false;
    responses.sort((a, b) => b.timestamp - a.timestamp);
  }

  res.json({
    isFromCloud,
    isFromSql,
    responses
  });
});

// Delete a response
app.delete('/api/responses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.deleteResponse(id);
    
    // Attempt to delete local backup file if it exists
    const localFileName = `response-${id}.json`;
    const localFilePath = path.join(DATA_DIR, localFileName);
    if (fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
      } catch (err) {
        console.warn(`Could not delete local backup file ${localFileName}:`, err.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(`Failed to delete response ${id}:`, err.message);
    res.status(500).json({ error: "Failed to delete response." });
  }
});

// Start Server locally if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Quiz server is running at http://localhost:${PORT}`);
  });
}

// Export the App for Vercel serverless integration
module.exports = app;

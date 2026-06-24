require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

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

// Initialize Google Cloud Storage Client
let storage = null;
let bucket = null;
const bucketName = process.env.GCS_BUCKET_NAME;

if (bucketName) {
  try {
    // 1. Prioritize direct environment variables configuration (best for serverless environments like Vercel)
    if (process.env.GCP_PROJECT_ID && process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY) {
      storage = new Storage({
        projectId: process.env.GCP_PROJECT_ID,
        credentials: {
          client_email: process.env.GCP_CLIENT_EMAIL,
          private_key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n')
        }
      });
      console.log("Google Cloud Storage client initialized using direct GCP credentials env variables.");
    } 
    // 2. Fall back to GOOGLE_APPLICATION_CREDENTIALS file path
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const credsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      if (fs.existsSync(credsPath)) {
        storage = new Storage({ keyFilename: credsPath });
        console.log(`Google Cloud Storage client initialized using keyFilename at: ${credsPath}`);
      } else {
        console.warn(`Warning: GOOGLE_APPLICATION_CREDENTIALS file not found at: ${credsPath}. Attempting to use default credentials.`);
        storage = new Storage();
      }
    } 
    // 3. Fall back to Application Default Credentials
    else {
      storage = new Storage();
      console.log("Google Cloud Storage client initialized using default credentials.");
    }
    
    bucket = storage.bucket(bucketName);
  } catch (err) {
    console.error("Failed to initialize Google Cloud Storage client:", err.message);
  }
} else {
  console.log("No GCS_BUCKET_NAME configured. Running in local-only fallback mode.");
}

// Helpers
async function uploadToGCS(fileName, fileContent) {
  if (!bucket) return false;
  try {
    const file = bucket.file(`responses/${fileName}`);
    await file.save(fileContent, {
      contentType: 'application/json',
      resumable: false,
    });
    console.log(`Successfully uploaded response to GCS: responses/${fileName}`);
    return true;
  } catch (err) {
    console.error(`GCS upload failed for ${fileName}:`, err.message);
    return false;
  }
}

async function fetchResponsesFromGCS() {
  if (!bucket) return null;
  try {
    const [files] = await bucket.getFiles({ prefix: 'responses/' });
    const fetchPromises = files
      .filter(file => file.name.endsWith('.json'))
      .map(async (file) => {
        try {
          const [content] = await file.download();
          return JSON.parse(content.toString());
        } catch (e) {
          console.error(`Error downloading GCS file ${file.name}:`, e.message);
          return null;
        }
      });
    const results = await Promise.all(fetchPromises);
    return results.filter(r => r !== null);
  } catch (err) {
    console.error("Failed to fetch responses from GCS bucket:", err.message);
    return null;
  }
}

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
  let gcsConnected = false;
  if (bucket) {
    try {
      const [exists] = await bucket.exists();
      gcsConnected = exists;
    } catch (e) {
      gcsConnected = false;
      console.warn("GCS connectivity check failed:", e.message);
    }
  }
  
  res.json({
    gcsConnected,
    bucketName: bucketName || null,
    localCount: fetchLocalResponses().length,
    isVercel: !!process.env.VERCEL
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
  
  // 1. Save local backup file
  const localSaved = saveLocalResponse(fileName, contentString);
  
  // 2. Upload to GCS if configured
  let storedInCloud = false;
  if (bucket) {
    storedInCloud = await uploadToGCS(fileName, contentString);
  }

  res.json({
    success: true,
    id: responseId,
    storedInCloud,
    localSaved
  });
});

// Get all responses (admin dashboard)
app.get('/api/responses', async (req, res) => {
  let responses = null;
  
  if (bucket) {
    responses = await fetchResponsesFromGCS();
  }
  
  let isFromCloud = true;
  if (responses === null) {
    console.log("GCS responses not available, falling back to local files.");
    responses = fetchLocalResponses();
    isFromCloud = false;
  }

  responses.sort((a, b) => b.timestamp - a.timestamp);

  res.json({
    isFromCloud,
    responses
  });
});

// Start Server locally if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Quiz server is running at http://localhost:${PORT}`);
  });
}

// Export the App for Vercel serverless integration
module.exports = app;

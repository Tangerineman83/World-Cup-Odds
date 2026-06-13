const express = require('express');
const path = require('path');
const fs = require('fs');
const { buildComparison } = require('./compare');

const app = express();
const PORT = process.env.PORT || 3000;

// Refresh interval: be respectful to eloratings.net (no official API / ToS for scraping).
// Hourly is more than sufficient since Elo ratings only change after international matches,
// and betting odds, while they move faster, don't need sub-hourly resolution for this use case.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const CACHE_FILE = path.join(__dirname, '..', 'data', 'latest.json');

let cache = {
  data: null,
  lastUpdated: null,
  lastError: null,
};

// Load any previously cached snapshot on startup so the page has data immediately
// even before the first live fetch completes.
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    cache.data = JSON.parse(raw);
    cache.lastUpdated = cache.data.generatedAt;
    console.log(`Loaded cached snapshot from ${cache.lastUpdated}`);
  }
} catch (e) {
  console.warn('Could not load cache file:', e.message);
}

async function refresh() {
  try {
    console.log(`[${new Date().toISOString()}] Refreshing data...`);
    const data = await buildComparison();
    cache.data = data;
    cache.lastUpdated = data.generatedAt;
    cache.lastError = null;

    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    console.log(`[${new Date().toISOString()}] Refresh succeeded (${data.teams.length} teams)`);
  } catch (e) {
    cache.lastError = { message: e.message, at: new Date().toISOString() };
    console.error(`[${new Date().toISOString()}] Refresh failed:`, e.message);
  }
}

// Kick off an initial fetch immediately, then on an interval.
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/comparison', (req, res) => {
  if (!cache.data) {
    return res.status(503).json({
      error: 'No data available yet. Initial fetch may still be in progress, or failed.',
      lastError: cache.lastError,
    });
  }
  res.json({
    ...cache.data,
    meta: {
      lastUpdated: cache.lastUpdated,
      lastError: cache.lastError,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    },
  });
});

// Manual refresh trigger (e.g. for an admin/cron hitting this endpoint),
// in addition to the automatic interval.
app.post('/api/refresh', async (req, res) => {
  await refresh();
  res.json({ ok: !cache.lastError, lastUpdated: cache.lastUpdated, lastError: cache.lastError });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getMonitoredProviders, updateProviderCookie } from './dbUpdater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const logs = [];
function addLog(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };
  logs.unshift(entry);
  if (logs.length > config.logLimit) logs.pop();
  console.log(`[${entry.timestamp}] [${level.toUpperCase()}] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

// Initialize DB on startup
try {
  const { hasKey } = initDb(config);
  addLog('info', `OmniRoute SQLite connected. Encryption active: ${hasKey}`);
} catch (err) {
  addLog('error', `Failed to initialize database: ${err.message}`);
}

function setCorsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function jsonResponse(res, statusCode, data) {
  setCorsHeaders(null, res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // GET /health
  if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
    return jsonResponse(res, 200, {
      status: 'online',
      service: 'OmniRoute Chrome Cookie Sync Bridge',
      version: '1.0.0',
      bridgePort: config.port,
      omniroutePort: 20128,
      timestamp: new Date().toISOString()
    });
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    try {
      const providers = getMonitoredProviders();
      return jsonResponse(res, 200, {
        success: true,
        providers,
        recentLogs: logs.slice(0, 10),
        totalProviders: providers.length
      });
    } catch (err) {
      addLog('error', 'Error fetching status', { error: err.message });
      return jsonResponse(res, 500, { success: false, error: err.message });
    }
  }

  // GET /api/needed
  if (req.method === 'GET' && pathname === '/api/needed') {
    try {
      const providers = getMonitoredProviders();
      const activeProviderNames = providers.filter(p => p.isActive).map(p => p.provider);
      return jsonResponse(res, 200, {
        success: true,
        activeProviders: activeProviderNames,
        allProviders: providers
      });
    } catch (err) {
      return jsonResponse(res, 500, { success: false, error: err.message });
    }
  }

  // GET /api/logs
  if (req.method === 'GET' && pathname === '/api/logs') {
    return jsonResponse(res, 200, {
      success: true,
      logs
    });
  }

  // POST /api/sync
  if (req.method === 'POST' && pathname === '/api/sync') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { provider, cookie, cookies, source } = payload;
        const cookieValue = cookie || cookies;

        if (!provider || !cookieValue) {
          return jsonResponse(res, 400, {
            success: false,
            error: "Missing required fields: 'provider' and 'cookie'"
          });
        }

        const result = updateProviderCookie(provider, cookieValue, { source });
        addLog('info', `Successfully synced cookies for provider: ${provider}`, {
          provider,
          updatedConnections: result.updatedConnections,
          source: source || 'chrome-extension'
        });

        return jsonResponse(res, 200, {
          success: true,
          message: `Synced cookies for ${provider}`,
          result
        });
      } catch (err) {
        addLog('error', 'Failed to process sync request', { error: err.message });
        return jsonResponse(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // POST /api/sync/bulk
  if (req.method === 'POST' && pathname === '/api/sync/bulk') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const updates = payload.updates || [];
        const results = [];

        for (const item of updates) {
          const { provider, cookie, cookies, source } = item;
          const cookieValue = cookie || cookies;
          if (provider && cookieValue) {
            try {
              const resObj = updateProviderCookie(provider, cookieValue, { source });
              results.push({ provider, success: true, result: resObj });
              addLog('info', `Bulk synced: ${provider}`);
            } catch (e) {
              results.push({ provider, success: false, error: e.message });
              addLog('warn', `Failed bulk sync for ${provider}: ${e.message}`);
            }
          }
        }

        return jsonResponse(res, 200, {
          success: true,
          count: results.length,
          results
        });
      } catch (err) {
        addLog('error', 'Failed to process bulk sync', { error: err.message });
        return jsonResponse(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // 404 fallback
  return jsonResponse(res, 404, { success: false, error: 'Endpoint not found' });
});

server.listen(config.port, config.host, () => {
  addLog('info', `OmniRoute Cookie Sync Bridge listening on http://${config.host}:${config.port}`);
  console.log(`\n======================================================`);
  console.log(`  OmniRoute Chrome Cookie Sync Bridge Active`);
  console.log(`  Bridge API: http://${config.host}:${config.port}`);
  console.log(`  Status endpoint: http://${config.host}:${config.port}/api/status`);
  console.log(`======================================================\n`);
});

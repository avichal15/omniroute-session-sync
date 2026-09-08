import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('C:/Users/avich/AppData/Roaming/npm/node_modules/omniroute/node_modules/better-sqlite3');

const STATIC_SALT = "omniroute-field-encryption-v1";
const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";

let _db = null;
let _cipherKey = null;

export function initDb(config = {}) {
  const envPath = config.envPath || 'C:/Users/avich/.omniroute/.env';
  const dbPath = config.dbPath || 'C:/Users/avich/.omniroute/storage.sqlite';

  if (!_cipherKey) {
    let secret = process.env.STORAGE_ENCRYPTION_KEY;
    if (!secret && fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/STORAGE_ENCRYPTION_KEY=([a-f0-9]+)/i);
      if (match) secret = match[1];
    }
    if (secret) {
      _cipherKey = scryptSync(secret, STATIC_SALT, 32);
    }
  }

  if (!_db) {
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
  }

  return { db: _db, hasKey: !!_cipherKey };
}

export function encrypt(plaintext) {
  if (!_cipherKey || !plaintext) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted

  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, _cipherKey, iv, { authTagLength: 16 });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${encrypted}:${tag.toString('hex')}`;
}

export function decrypt(ciphertext) {
  if (!_cipherKey || !ciphertext || !ciphertext.startsWith(PREFIX)) return ciphertext;
  try {
    const parts = ciphertext.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, encHex, tagHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, _cipherKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[DB] Decryption error:', err.message);
    return null;
  }
}

export function getMonitoredProviders() {
  initDb();
  const query = `
    SELECT id, provider, auth_type, is_active, test_status, last_tested, updated_at, api_key
    FROM provider_connections
    WHERE provider LIKE '%web%' 
       OR provider IN ('chatgpt-web', 'gemini-web', 'zai-web', 'qwen-web', 'deepseek-web', 'grok-web', 'claude-web', 'perplexity-web', 'lmarena', 'inner-ai', 'promptql')
    ORDER BY provider ASC
  `;
  const rows = _db.prepare(query).all();
  return rows.map(r => {
    const rawKey = decrypt(r.api_key);
    let preview = 'None';
    if (rawKey) {
      preview = rawKey.length > 25 ? rawKey.slice(0, 15) + '...' + rawKey.slice(-10) : rawKey;
    }
    return {
      id: r.id,
      provider: r.provider,
      authType: r.auth_type,
      isActive: Boolean(r.is_active),
      testStatus: r.test_status,
      lastTested: r.last_tested,
      updatedAt: r.updated_at,
      hasKey: Boolean(r.api_key),
      keyPreview: preview
    };
  });
}

export function updateProviderCookie(provider, cookieValue, metadata = {}) {
  initDb();
  if (!cookieValue || typeof cookieValue !== 'string') {
    throw new Error('Invalid cookie value provided');
  }

  const encryptedKey = encrypt(cookieValue.trim());
  const now = new Date().toISOString();

  // Find existing connections for this provider
  const rows = _db.prepare("SELECT id, provider FROM provider_connections WHERE provider = ?").all(provider);

  if (rows.length === 0) {
    return {
      success: false,
      message: `No existing connection row found for provider '${provider}'. Please add it first in OmniRoute UI.`,
      updatedRows: 0
    };
  }

  const updateStmt = _db.prepare(`
    UPDATE provider_connections
    SET api_key = @apiKey,
        updated_at = @updatedAt,
        test_status = 'active',
        last_error = NULL,
        last_error_at = NULL,
        error_code = NULL
    WHERE id = @id
  `);

  const results = [];
  const updateMany = _db.transaction((items) => {
    for (const item of items) {
      const info = updateStmt.run({
        id: item.id,
        apiKey: encryptedKey,
        updatedAt: now
      });
      results.push({ id: item.id, changes: info.changes });
    }
  });

  updateMany(rows);

  return {
    success: true,
    provider,
    updatedAt: now,
    updatedConnections: rows.map(r => r.id),
    source: metadata.source || 'chrome-extension'
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const GENERATED_DIR = path.join(DATA_DIR, 'generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * JSON file store (fallback, works on every Node version)
 * ------------------------------------------------------------------ */
class JsonStore {
  constructor() {
    this.backend = 'json-file';
    this.file = path.join(DATA_DIR, 'voxora.json');
    this.state = { users: [], generations: [], favourites: [], seq: { users: 0, generations: 0, favourites: 0 } };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.users)) {
        this.state = {
          users: parsed.users || [],
          generations: parsed.generations || [],
          favourites: parsed.favourites || [],
          seq: { ...this.state.seq, ...(parsed.seq || {}) }
        };
      }
    } catch {
      /* first run */
    }
    this.writeQueue = Promise.resolve();
    this.persist();
  }

  persist() {
    const snapshot = JSON.stringify(this.state);
    this.writeQueue = this.writeQueue
      .then(() => {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, snapshot);
        fs.renameSync(tmp, this.file);
      })
      .catch(() => {});
    return this.writeQueue;
  }

  next(kind) {
    this.state.seq[kind] = (this.state.seq[kind] || 0) + 1;
    return this.state.seq[kind];
  }

  createUser({ name, email, password }) {
    const user = { id: this.next('users'), name, email, password, created_at: nowIso() };
    this.state.users.push(user);
    this.persist();
    return { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
  }

  userByEmail(email) {
    return this.state.users.find((u) => u.email === email) || null;
  }

  userById(id) {
    return this.state.users.find((u) => u.id === Number(id)) || null;
  }

  addGeneration({ userId, kind, title, text, voiceId, fileName, engine }) {
    const row = {
      id: this.next('generations'),
      user_id: Number(userId),
      kind,
      title: title || '',
      text: text || '',
      voice_id: voiceId || null,
      file_name: fileName || null,
      engine: engine || null,
      created_at: nowIso()
    };
    this.state.generations.push(row);
    this.persist();
    return row;
  }

  listGenerations(userId, limit = 100) {
    return this.state.generations
      .filter((g) => g.user_id === Number(userId))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  generationById(userId, id) {
    return this.state.generations.find((g) => g.user_id === Number(userId) && g.id === Number(id)) || null;
  }

  deleteGeneration(userId, id) {
    const idx = this.state.generations.findIndex((g) => g.user_id === Number(userId) && g.id === Number(id));
    if (idx === -1) return null;
    const [row] = this.state.generations.splice(idx, 1);
    this.persist();
    return row;
  }

  listFavourites(userId) {
    return this.state.favourites.filter((f) => f.user_id === Number(userId));
  }

  toggleFavourite(userId, voiceId, voiceName) {
    const uid = Number(userId);
    const idx = this.state.favourites.findIndex((f) => f.user_id === uid && f.voice_id === voiceId);
    if (idx !== -1) {
      this.state.favourites.splice(idx, 1);
      this.persist();
      return false;
    }
    this.state.favourites.push({ id: this.next('favourites'), user_id: uid, voice_id: voiceId, voice_name: voiceName });
    this.persist();
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * SQLite store (preferred when node:sqlite is available, Node >= 22.5)
 * ------------------------------------------------------------------ */
class SqliteStore {
  constructor(DatabaseSync) {
    this.backend = 'sqlite';
    this.db = new DatabaseSync(path.join(DATA_DIR, 'voxora.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT,
        voice_id TEXT,
        file_name TEXT,
        engine TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS favourites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        voice_id TEXT NOT NULL,
        voice_name TEXT NOT NULL,
        UNIQUE (user_id, voice_id)
      );
      CREATE INDEX IF NOT EXISTS idx_generations_user ON generations (user_id, id);
    `);
  }

  createUser({ name, email, password }) {
    const createdAt = nowIso();
    const info = this.db
      .prepare('INSERT INTO users (name, email, password, created_at) VALUES (?, ?, ?, ?)')
      .run(name, email, password, createdAt);
    return { id: Number(info.lastInsertRowid), name, email, created_at: createdAt };
  }

  userByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  }

  userById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
  }

  addGeneration({ userId, kind, title, text, voiceId, fileName, engine }) {
    const createdAt = nowIso();
    const info = this.db
      .prepare(
        'INSERT INTO generations (user_id, kind, title, text, voice_id, file_name, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(Number(userId), kind, title || '', text || '', voiceId || null, fileName || null, engine || null, createdAt);
    return {
      id: Number(info.lastInsertRowid),
      user_id: Number(userId),
      kind,
      title: title || '',
      text: text || '',
      voice_id: voiceId || null,
      file_name: fileName || null,
      engine: engine || null,
      created_at: createdAt
    };
  }

  listGenerations(userId, limit = 100) {
    return this.db
      .prepare('SELECT * FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(Number(userId), Number(limit));
  }

  generationById(userId, id) {
    return (
      this.db.prepare('SELECT * FROM generations WHERE user_id = ? AND id = ?').get(Number(userId), Number(id)) || null
    );
  }

  deleteGeneration(userId, id) {
    const row = this.generationById(userId, id);
    if (!row) return null;
    this.db.prepare('DELETE FROM generations WHERE id = ?').run(row.id);
    return row;
  }

  listFavourites(userId) {
    return this.db.prepare('SELECT * FROM favourites WHERE user_id = ?').all(Number(userId));
  }

  toggleFavourite(userId, voiceId, voiceName) {
    const uid = Number(userId);
    const existing = this.db.prepare('SELECT * FROM favourites WHERE user_id = ? AND voice_id = ?').get(uid, voiceId);
    if (existing) {
      this.db.prepare('DELETE FROM favourites WHERE id = ?').run(existing.id);
      return false;
    }
    this.db.prepare('INSERT INTO favourites (user_id, voice_id, voice_name) VALUES (?, ?, ?)').run(uid, voiceId, voiceName);
    return true;
  }
}

/* ------------------------------------------------------------------ */

let store;
try {
  const { DatabaseSync } = require('node:sqlite');
  store = new SqliteStore(DatabaseSync);
} catch (err) {
  store = new JsonStore();
  store.fallbackReason = err && err.message ? err.message : 'node:sqlite unavailable';
}

export { store };

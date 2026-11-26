/**
 * Persistence layer.
 *
 * Uses an atomic JSON document store (write-to-temp + rename) so the app runs on
 * any Node version without native modules or a paid database service.
 * Data lives in DATA_DIR, which hosting can mount on a persistent disk later.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const GENERATED_DIR = path.join(DATA_DIR, 'generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'voxora.json');
const nowIso = () => new Date().toISOString();

const empty = () => ({
  users: [],
  generations: [],
  favourites: [],
  counters: { user: 0, generation: 0, favourite: 0 },
});

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const db = empty();
    return {
      users: Array.isArray(parsed.users) ? parsed.users : db.users,
      generations: Array.isArray(parsed.generations) ? parsed.generations : db.generations,
      favourites: Array.isArray(parsed.favourites) ? parsed.favourites : db.favourites,
      counters: { ...db.counters, ...(parsed.counters || {}) },
    };
  } catch {
    return empty();
  }
}

let db = load();

function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nextId(kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  return db.counters[kind];
}

const publicUser = (u) => (u ? { id: u.id, name: u.name, email: u.email, created_at: u.created_at } : null);

export const store = {
  backend: 'json-file (atomic writes)',

  createUser({ name, email, passwordHash }) {
    const existing = store.userByEmail(email);
    if (existing) return { error: 'An account with that email already exists.' };
    const user = {
      id: nextId('user'),
      name: name || email.split('@')[0],
      email,
      password_hash: passwordHash,
      created_at: nowIso(),
    };
    db.users.push(user);
    save();
    return { user: publicUser(user) };
  },

  userByEmail(email) {
    if (!email) return null;
    return db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
  },

  userById(id) {
    return db.users.find((u) => u.id === Number(id)) || null;
  },

  addGeneration(entry) {
    const record = {
      id: nextId('generation'),
      user_id: Number(entry.userId ?? entry.user_id),
      kind: entry.kind,
      title: entry.title || entry.kind,
      text: entry.text || entry.prompt || '',
      voice_id: entry.voiceId ?? entry.voice_id ?? null,
      engine: entry.engine || null,
      file_name: entry.fileName ?? entry.file_name ?? null,
      created_at: nowIso(),
    };
    db.generations.unshift(record);
    if (db.generations.length > 2000) db.generations.length = 2000;
    save();
    return record;
  },

  listGenerations(userId, limit = 100) {
    return db.generations
      .filter((g) => g.user_id === Number(userId))
      .slice(0, Math.max(1, Number(limit) || 100));
  },

  generationById(userId, id) {
    return (
      db.generations.find((g) => g.id === Number(id) && g.user_id === Number(userId)) || null
    );
  },

  deleteGeneration(userId, id) {
    const idx = db.generations.findIndex(
      (g) => g.id === Number(id) && g.user_id === Number(userId),
    );
    if (idx === -1) return null;
    const [removed] = db.generations.splice(idx, 1);
    save();
    return removed;
  },

  listFavourites(userId) {
    return db.favourites
      .filter((f) => f.user_id === Number(userId))
      .map((f) => ({ voice_id: f.voice_id, name: f.name, created_at: f.created_at }));
  },

  toggleFavourite(userId, { voice_id, name }) {
    const uid = Number(userId);
    const idx = db.favourites.findIndex((f) => f.user_id === uid && f.voice_id === voice_id);
    if (idx !== -1) {
      db.favourites.splice(idx, 1);
      save();
      return { saved: false, favourites: store.listFavourites(uid) };
    }
    db.favourites.push({
      id: nextId('favourite'),
      user_id: uid,
      voice_id,
      name: name || voice_id,
      created_at: nowIso(),
    });
    save();
    return { saved: true, favourites: store.listFavourites(uid) };
  },

  stats() {
    return { users: db.users.length, generations: db.generations.length };
  },
};

export default store;

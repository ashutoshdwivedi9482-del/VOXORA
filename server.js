import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { store, GENERATED_DIR, DATA_DIR } from './db.js';
import { FREE_VOICES, voiceById, freeSpeech, proceduralSound } from './audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 2;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '30mb' }));

/* ----------------------------- helpers ----------------------------- */

function loadSecret() {
  const fromEnv = process.env.JWT_SECRET || process.env.SECRET_KEY;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = path.join(DATA_DIR, 'jwt.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* generate below */
  }
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch {
    /* read-only filesystem: token secret stays in memory for this process */
  }
  return generated;
}

const SECRET = loadSecret();

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    return Number(data.uid);
  } catch {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

const authAttempts = new Map();
function authThrottle(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || entry.reset < now) {
    authAttempts.set(key, { count: 1, reset: now + 10 * 60 * 1000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > 40) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  return next();
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = readToken(token);
  if (!userId) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  const user = store.userById(userId);
  if (!user) return res.status(401).json({ error: 'Account not found. Please sign in again.' });
  req.user = user;
  return next();
}

function saveAudio(buffer, extension) {
  const fileName = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(GENERATED_DIR, fileName), buffer);
  return fileName;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* --------------------------- health --------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VOXORA API',
    storage: store.backend,
    engines: {
      speech: ELEVENLABS_KEY ? 'elevenlabs' : 'google-tts (free)',
      soundEffects: ELEVENLABS_KEY ? 'elevenlabs' : 'local synth (free)',
      transcription: OPENAI_KEY ? 'openai-whisper' : 'browser speech (free)',
      elevenlabs: Boolean(ELEVENLABS_KEY),
      openai: Boolean(OPENAI_KEY)
    }
  });
});

/* ---------------------------- auth ---------------------------- */

app.post('/api/auth/register', authThrottle, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');
  if (!name || !EMAIL_RE.test(email) || password.length < 8) {
    return res.status(400).json({ error: 'Name, a valid email and a password of at least 8 characters are required.' });
  }
  if (store.userByEmail(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const user = store.createUser({ name, email, password: hashPassword(password) });
  return res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
});

app.post('/api/auth/login', authThrottle, (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');
  const user = store.userByEmail(email);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  return res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

/* ---------------------------- voices --------------------------- */

let providerVoiceCache = { at: 0, voices: [] };

async function providerVoices() {
  if (!ELEVENLABS_KEY) return [];
  if (Date.now() - providerVoiceCache.at < 10 * 60 * 1000) return providerVoiceCache.voices;
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_KEY },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const data = await res.json();
    const voices = (data.voices || []).map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || 'premade',
      engine: 'elevenlabs',
      preview_url: v.preview_url || null,
      labels: {
        accent: v.labels?.accent || 'Provider voice',
        description: v.labels?.description || v.labels?.use_case || 'AI voice',
        gender: v.labels?.gender || '',
        language: v.labels?.language || 'Multilingual'
      }
    }));
    providerVoiceCache = { at: Date.now(), voices };
    return voices;
  } catch (err) {
    console.warn('[voices] provider unavailable, serving free voices:', err.message);
    return providerVoiceCache.voices;
  }
}

app.get('/api/voices', async (req, res) => {
  const premium = await providerVoices();
  res.json([...premium, ...FREE_VOICES]);
});

const PREVIEW_TEXT = {
  en: (name) => `Hello, I am ${name}. This is how I sound on Voxora.`,
  'en-GB': (name) => `Hello, I am ${name}. This is how I sound on Voxora.`,
  'en-AU': (name) => `Hello, I am ${name}. This is how I sound on Voxora.`,
  'en-IN': (name) => `Hello, I am ${name}. This is how I sound on Voxora.`,
  es: (name) => `Hola, soy ${name}. Asi suena mi voz en Voxora.`,
  fr: (name) => `Bonjour, je suis ${name}. Voici ma voix sur Voxora.`,
  de: (name) => `Hallo, ich bin ${name}. So klinge ich bei Voxora.`,
  it: (name) => `Ciao, sono ${name}. Ecco come suono su Voxora.`,
  pt: (name) => `Ola, eu sou ${name}. Esta e a minha voz no Voxora.`,
  hi: (name) => `Namaste, main ${name} hoon. Voxora par meri awaaz aisi hai.`,
  ja: (name) => `Konnichiwa, ${name} desu. Kore ga Voxora de no watashi no koe desu.`,
  ar: (name) => `Marhaban, ana ${name}. Hatha huwa sawti ala Voxora.`
};

app.get('/api/voices/:voiceId/preview', async (req, res) => {
  const voice = voiceById(req.params.voiceId);
  if (!voice) return res.status(404).json({ error: 'Voice not found.' });
  const cached = path.join(GENERATED_DIR, `preview-${voice.voice_id}.mp3`);
  if (fs.existsSync(cached)) {
    res.type('audio/mpeg');
    return res.send(fs.readFileSync(cached));
  }
  try {
    const build = PREVIEW_TEXT[voice.tl] || PREVIEW_TEXT.en;
    const { buffer } = await freeSpeech(build(voice.name), { tl: voice.tl, speed: 1 });
    fs.writeFileSync(cached, buffer);
    res.type('audio/mpeg');
    return res.send(buffer);
  } catch (err) {
    console.error('[preview] failed:', err.message);
    return res.status(502).json({ error: 'Voice preview is unavailable right now.' });
  }
});

/* ----------------------------- tts ----------------------------- */

async function elevenSpeech(text, voiceId, settings) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: Number(settings?.stability ?? 0.5),
        similarity_boost: Number(settings?.similarity ?? 0.75),
        style: Number(settings?.style ?? 0),
        use_speaker_boost: true
      }
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`ElevenLabs responded ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

app.post('/api/tts', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const voiceId = String(req.body?.voice_id || '').trim();
  const speed = Math.min(2, Math.max(0.5, Number(req.body?.speed) || 1));
  if (!text) return res.status(400).json({ error: 'Please enter some text first.' });
  if (!voiceId) return res.status(400).json({ error: 'Please choose a voice.' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text limit is 5,000 characters.' });

  const freeVoice = voiceById(voiceId);
  try {
    let buffer;
    let engine;
    let extension = 'mp3';
    if (ELEVENLABS_KEY && !freeVoice) {
      buffer = await elevenSpeech(text, voiceId, req.body?.settings);
      engine = 'elevenlabs';
    } else {
      const tl = freeVoice?.tl || String(req.body?.language || 'en');
      const result = await freeSpeech(text, { tl, speed });
      buffer = result.buffer;
      engine = result.engine;
    }
    const fileName = saveAudio(buffer, extension);
    const item = store.addGeneration({
      userId: req.user.id,
      kind: 'tts',
      title: text.slice(0, 70),
      text,
      voiceId,
      fileName,
      engine
    });
    return res.json({
      id: item.id,
      audio_url: `/api/files/${fileName}`,
      download_url: `/api/files/${fileName}?download=1`,
      engine,
      voice_id: voiceId,
      title: item.title
    });
  } catch (err) {
    console.error('[tts] failed:', err.message);
    return res.status(502).json({
      error: `Speech generation failed: ${err.message}. The free speech engine could not be reached, please try again.`
    });
  }
});

/* ------------------------- sound effects ------------------------ */

async function elevenSound(prompt, duration) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: Math.min(22, Math.max(0.5, Number(duration) || 5)),
      prompt_influence: 0.3
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`ElevenLabs responded ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

app.post('/api/sound-effects', requireAuth, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const duration = Math.min(10, Math.max(1, Number(req.body?.duration) || 5));
  if (!prompt) return res.status(400).json({ error: 'Describe the sound you want.' });
  try {
    let buffer;
    let engine;
    let extension;
    if (ELEVENLABS_KEY) {
      buffer = await elevenSound(prompt, duration);
      engine = 'elevenlabs';
      extension = 'mp3';
    } else {
      const result = proceduralSound(prompt, duration);
      buffer = result.buffer;
      engine = result.engine;
      extension = 'wav';
    }
    const fileName = saveAudio(buffer, extension);
    const item = store.addGeneration({
      userId: req.user.id,
      kind: 'sound',
      title: prompt.slice(0, 70),
      text: prompt,
      fileName,
      engine
    });
    return res.json({
      id: item.id,
      audio_url: `/api/files/${fileName}`,
      download_url: `/api/files/${fileName}?download=1`,
      engine,
      title: item.title
    });
  } catch (err) {
    console.error('[sound] failed:', err.message);
    return res.status(502).json({ error: `Sound generation failed: ${err.message}` });
  }
});

/* --------------------------- transcribe ------------------------- */

app.post('/api/transcribe', requireAuth, async (req, res) => {
  const browserText = String(req.body?.text || '').trim();
  if (browserText) {
    if (browserText.length > 20000) return res.status(400).json({ error: 'Transcript is too long.' });
    const item = store.addGeneration({
      userId: req.user.id,
      kind: 'transcription',
      title: (req.body?.title || browserText.slice(0, 60)).toString().slice(0, 120),
      text: browserText,
      engine: 'browser-speech'
    });
    return res.json({ id: item.id, text: browserText, engine: 'browser-speech' });
  }

  const base64 = String(req.body?.audio_base64 || '');
  if (!base64) return res.status(400).json({ error: 'Choose an audio file or record from your microphone.' });
  if (!OPENAI_KEY) {
    return res.status(503).json({
      error:
        'File transcription needs an OpenAI API key on the server. Free alternative: use the microphone recorder above, which transcribes in your browser with no API key.'
    });
  }
  const filename = String(req.body?.filename || 'audio.mp3').replace(/[^A-Za-z0-9._-]/g, '_');
  const mime = String(req.body?.mime || 'audio/mpeg');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 24 * 1024 * 1024) return res.status(413).json({ error: 'Audio file must be smaller than 24 MB.' });

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', 'whisper-1');
    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
      signal: AbortSignal.timeout(180000)
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new Error(`OpenAI responded ${upstream.status} ${detail.slice(0, 160)}`);
    }
    const data = await upstream.json();
    const text = String(data.text || '').trim();
    const item = store.addGeneration({
      userId: req.user.id,
      kind: 'transcription',
      title: filename,
      text,
      engine: 'openai-whisper'
    });
    return res.json({ id: item.id, text, engine: 'openai-whisper' });
  } catch (err) {
    console.error('[transcribe] failed:', err.message);
    return res.status(502).json({ error: `Transcription failed: ${err.message}` });
  }
});

/* ---------------------------- files ---------------------------- */

app.get('/api/files/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[A-Za-z0-9_-]+\.(mp3|wav)$/.test(name)) return res.status(400).json({ error: 'Invalid filename.' });
  const full = path.join(GENERATED_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Audio file not found.' });
  if (req.query.download === '1') return res.download(full, name);
  res.type(name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
  return res.send(fs.readFileSync(full));
});

/* --------------------------- history --------------------------- */

function serializeGeneration(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    text: row.text,
    voice_id: row.voice_id,
    engine: row.engine || null,
    audio_url: row.file_name ? `/api/files/${row.file_name}` : null,
    download_url: row.file_name ? `/api/files/${row.file_name}?download=1` : null,
    created_at: row.created_at
  };
}

app.get('/api/history', requireAuth, (req, res) => {
  res.json(store.listGenerations(req.user.id, 100).map(serializeGeneration));
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  const row = store.deleteGeneration(req.user.id, Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'History item not found.' });
  if (row.file_name) {
    const full = path.join(GENERATED_DIR, row.file_name);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* file already gone */
    }
  }
  return res.json({ deleted: true });
});

/* ------------------------- favourites ------------------------- */

function favouriteList(userId) {
  return store.listFavourites(userId).map((row) => ({ voice_id: row.voice_id, name: row.voice_name }));
}

app.get('/api/favourites', requireAuth, (req, res) => {
  res.json(favouriteList(req.user.id));
});

app.post('/api/favourites', requireAuth, (req, res) => {
  const voiceId = String(req.body?.voice_id || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!voiceId || !name) return res.status(400).json({ error: 'Voice ID and name are required.' });
  const saved = store.toggleFavourite(req.user.id, voiceId, name);
  return res.json({ saved, favourites: favouriteList(req.user.id) });
});

/* --------------------------- static --------------------------- */

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    return res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('text/plain').send('VOXORA API is running. Run "npm run build" to serve the frontend from this server.');
  });
}

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VOXORA running on http://0.0.0.0:${PORT} (storage: ${store.backend})`);
  if (store.fallbackReason) console.log(`[db] sqlite unavailable, using JSON store: ${store.fallbackReason}`);
  console.log(
    `[engines] speech=${ELEVENLABS_KEY ? 'elevenlabs' : 'google-tts (free)'} sound=${
      ELEVENLABS_KEY ? 'elevenlabs' : 'local synth (free)'
    } transcription=${OPENAI_KEY ? 'whisper' : 'browser (free)'}`
  );
});

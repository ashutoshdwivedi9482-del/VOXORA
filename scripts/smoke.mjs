/**
 * End-to-end API smoke test for VOXORA.
 * Boots the real server against a throwaway data directory and exercises
 * auth, voices, TTS, sound effects, transcription, history and favourites.
 *
 * Run with: node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voxora-smoke-'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
function pass(name, detail = '') {
  results.push({ name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start in time:\n${serverLog}`);
}

async function req(pathname, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

try {
  await waitForServer();

  // health
  const health = await req('/api/health');
  assert.equal(health.status, 200);
  assert.ok(health.data.engines?.speech, 'health reports a speech engine');
  pass('GET /api/health', `speech=${health.data.engines.speech}`);

  // auth
  const email = `smoke${Date.now()}@example.com`;
  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: { name: 'Smoke Tester', email, password: 'password123' },
  });
  assert.equal(reg.status, 200, `register failed: ${JSON.stringify(reg.data)}`);
  assert.ok(reg.data.token?.length > 10, 'register returns a token');
  assert.equal(reg.data.user.email, email);
  const token = reg.data.token;
  pass('POST /api/auth/register', 'token + user returned');

  const dup = await req('/api/auth/register', {
    method: 'POST',
    body: { name: 'Smoke Tester', email, password: 'password123' },
  });
  assert.equal(dup.status, 409, 'duplicate email rejected');
  pass('duplicate registration rejected', `status=${dup.status}`);

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token?.length > 10);
  pass('POST /api/auth/login', 'credentials accepted');

  const badLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'wrongpassword' },
  });
  assert.equal(badLogin.status, 401, 'wrong password rejected');
  pass('wrong password rejected', `status=${badLogin.status}`);

  const me = await req('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, email);
  pass('GET /api/auth/me', me.data.name);

  const unauth = await req('/api/history');
  assert.equal(unauth.status, 401, 'history requires auth');
  pass('protected route requires token', `status=${unauth.status}`);

  // voices
  const voices = await req('/api/voices', { token });
  assert.equal(voices.status, 200);
  assert.ok(Array.isArray(voices.data) && voices.data.length >= 4, 'voice list populated');
  assert.ok(
    voices.data.every((v) => v.voice_id && v.name && v.preview_url),
    'every voice has id, name and preview',
  );
  pass('GET /api/voices', `${voices.data.length} voices`);

  const preview = await fetch(`${BASE}${voices.data[0].preview_url}`);
  const previewBuf = Buffer.from(await preview.arrayBuffer());
  assert.equal(preview.status, 200, 'voice preview reachable');
  assert.ok(previewBuf.length > 1000, 'voice preview contains real audio bytes');
  pass('GET voice preview audio', `${previewBuf.length} bytes`);

  // text to speech
  const tts = await req('/api/tts', {
    token,
    method: 'POST',
    body: { text: 'Voxora turns your words into speech.', voice_id: voices.data[0].voice_id, speed: 1 },
  });
  assert.equal(tts.status, 200, `tts failed: ${JSON.stringify(tts.data)}`);
  assert.ok(tts.data.audio_url, 'tts returns audio_url');
  assert.ok(tts.data.engine, 'tts reports which engine produced the audio');
  const audioRes = await fetch(`${BASE}${tts.data.audio_url}`);
  const audioBuf = Buffer.from(await audioRes.arrayBuffer());
  assert.equal(audioRes.status, 200, 'generated audio is downloadable');
  assert.ok(audioBuf.length > 2000, 'generated audio is a real file');
  pass('POST /api/tts', `${audioBuf.length} bytes via ${tts.data.engine}`);

  const emptyTts = await req('/api/tts', { token, method: 'POST', body: { text: '' } });
  assert.equal(emptyTts.status, 400, 'empty text rejected');
  pass('empty script rejected', `status=${emptyTts.status}`);

  // sound effects
  const sfx = await req('/api/sound-effects', {
    token,
    method: 'POST',
    body: { prompt: 'gentle rain on a window', duration: 2 },
  });
  assert.equal(sfx.status, 200, `sfx failed: ${JSON.stringify(sfx.data)}`);
  assert.ok(sfx.data.audio_url, 'sfx returns audio_url');
  const sfxRes = await fetch(`${BASE}${sfx.data.audio_url}`);
  const sfxBuf = Buffer.from(await sfxRes.arrayBuffer());
  assert.ok(sfxBuf.length > 8000, 'sound effect is a real audio file');
  pass('POST /api/sound-effects', `${sfxBuf.length} bytes`);

  // transcription (server-side save path)
  const tr = await req('/api/transcribe', {
    token,
    method: 'POST',
    body: { text: 'a saved microphone transcript', title: 'Smoke transcript' },
  });
  assert.equal(tr.status, 200, `transcribe failed: ${JSON.stringify(tr.data)}`);
  pass('POST /api/transcribe', 'transcript stored');

  // favourites toggle
  const favOn = await req('/api/favourites', {
    token,
    method: 'POST',
    body: { voice_id: 'rachel', name: 'Rachel' },
  });
  assert.equal(favOn.status, 200);
  assert.equal(favOn.data.saved, true);
  const favList = await req('/api/favourites', { token });
  assert.ok(favList.data.some((f) => f.voice_id === 'rachel'), 'favourite persisted');
  const favOff = await req('/api/favourites', {
    token,
    method: 'POST',
    body: { voice_id: 'rachel', name: 'Rachel' },
  });
  assert.equal(favOff.data.saved, false, 'second tap removes the favourite');
  pass('favourites toggle persists', 'add + remove');

  // history + delete
  const history = await req('/api/history', { token });
  assert.equal(history.status, 200);
  const kinds = history.data.map((h) => h.kind);
  for (const kind of ['tts', 'sound', 'transcript']) {
    assert.ok(kinds.includes(kind), `history contains a ${kind} entry`);
  }
  assert.ok(history.data[0].created_at, 'history entries carry timestamps');
  pass('GET /api/history', `${history.data.length} entries (${[...new Set(kinds)].join(', ')})`);

  const delTarget = history.data[0];
  const del = await req(`/api/history/${delTarget.id}`, { token, method: 'DELETE' });
  assert.equal(del.status, 200);
  const afterDel = await req('/api/history', { token });
  assert.ok(!afterDel.data.some((h) => h.id === delTarget.id), 'deleted entry is gone');
  pass('DELETE /api/history/:id', 'entry removed');

  // persistence across restart
  await new Promise((r) => {
    server.once('exit', r);
    server.kill('SIGTERM');
  });
  const server2 = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
  const relogin = await req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  assert.equal(relogin.status, 200, 'account survives a server restart');
  const persisted = await req('/api/history', { token: relogin.data.token });
  assert.ok(persisted.data.length >= 2, 'history survives a server restart');
  pass('data persists across restart', `${persisted.data.length} entries after reboot`);
  server2.kill('SIGTERM');

  // SPA serving
  const index = await fetch(`${BASE}/`);
  const indexHtml = await index.text();
  assert.equal(index.status, 200);
  assert.ok(indexHtml.includes('id="root"'), 'app shell served');
  const deep = await fetch(`${BASE}/voices`);
  assert.equal(deep.status, 200, 'client-side route falls back to the app shell');
  pass('static app + SPA fallback served', 'GET / and GET /voices');

  console.log(`\n${results.length} checks passed.`);
  process.exit(0);
} catch (err) {
  console.error(`\nFAIL  ${err.message}`);
  if (serverLog) console.error(`\n--- server log ---\n${serverLog}`);
  server.kill('SIGKILL');
  process.exit(1);
}

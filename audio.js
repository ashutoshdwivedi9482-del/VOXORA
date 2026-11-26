/**
 * Audio engines.
 *
 * Free path (no API key, no credits):
 *  - speech: Google's public translate_tts endpoint, chunked into <=180 char pieces.
 *  - sound effects: procedural synthesis rendered to a WAV buffer.
 *
 * Paid/optional path: ElevenLabs is used when ELEVENLABS_API_KEY is configured.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const RAW_VOICES = [
  { voice_id: 'sarah', name: 'Sarah', gender: 'Female', tl: 'en', language: 'English (US)', accent: 'American', description: 'Warm and reassuring' },
  { voice_id: 'rachel', name: 'Rachel', gender: 'Female', tl: 'en-GB', language: 'English (UK)', accent: 'British', description: 'Calm and clear' },
  { voice_id: 'adam', name: 'Adam', gender: 'Male', tl: 'en-AU', language: 'English (AU)', accent: 'Australian', description: 'Deep and confident' },
  { voice_id: 'josh', name: 'Josh', gender: 'Male', tl: 'en-IN', language: 'English (IN)', accent: 'Indian', description: 'Conversational and friendly' },
  { voice_id: 'aria', name: 'Aria', gender: 'Female', tl: 'es', language: 'Spanish', accent: 'Castilian', description: 'Expressive and bright' },
  { voice_id: 'brian', name: 'Brian', gender: 'Male', tl: 'fr', language: 'French', accent: 'Metropolitan', description: 'Smooth and precise' },
  { voice_id: 'emma', name: 'Emma', gender: 'Female', tl: 'de', language: 'German', accent: 'Standard', description: 'Neutral and articulate' },
  { voice_id: 'grace', name: 'Grace', gender: 'Female', tl: 'it', language: 'Italian', accent: 'Standard', description: 'Melodic and lively' },
  { voice_id: 'daniel', name: 'Daniel', gender: 'Male', tl: 'pt', language: 'Portuguese', accent: 'Brazilian', description: 'Clear and welcoming' },
  { voice_id: 'ava', name: 'Ava', gender: 'Female', tl: 'hi', language: 'Hindi', accent: 'Standard', description: 'Natural and expressive' },
  { voice_id: 'liam', name: 'Liam', gender: 'Male', tl: 'ja', language: 'Japanese', accent: 'Standard', description: 'Composed and steady' },
  { voice_id: 'sofia', name: 'Sofia', gender: 'Female', tl: 'ar', language: 'Arabic', accent: 'Standard', description: 'Rich and confident' }
];

export const FREE_VOICES = RAW_VOICES.map((v) => ({
  voice_id: v.voice_id,
  name: v.name,
  category: 'free',
  engine: 'google-tts',
  preview_url: `/api/voices/${v.voice_id}/preview`,
  labels: {
    accent: v.accent,
    description: v.description,
    gender: v.gender,
    language: v.language
  },
  tl: v.tl
}));

export function voiceById(id) {
  return FREE_VOICES.find((v) => v.voice_id === id) || null;
}

/* ----------------------------- speech ----------------------------- */

function chunkText(text, max = 180) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?;:]+[.!?;:]*/g) || [clean];
  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length > max) {
      push();
      for (const word of piece.split(' ')) {
        if ((current + ' ' + word).trim().length > max) push();
        current = `${current} ${word}`.trim();
      }
      push();
    } else if ((current + ' ' + piece).trim().length > max) {
      push();
      current = piece;
    } else {
      current = `${current} ${piece}`.trim();
    }
  }
  push();
  return chunks;
}

function stripId3(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const end = 10 + size;
    return end < buf.length ? buf.subarray(end) : Buffer.alloc(0);
  }
  return buf;
}

async function fetchSpeechChunk(text, tl, speed) {
  const hosts = ['https://translate.google.com/translate_tts', 'https://translate.googleapis.com/translate_tts'];
  let lastError = null;
  for (const host of hosts) {
    const url = `${host}?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&ttsspeed=${speed}&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://translate.google.com/' },
        signal: AbortSignal.timeout(20000)
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('audio')) {
        lastError = new Error(`Speech provider responded ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 400) {
        lastError = new Error('Speech provider returned no audio');
        continue;
      }
      return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Speech provider unreachable');
}

export async function freeSpeech(text, { tl = 'en', speed = 1 } = {}) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('Nothing to speak');
  const safeSpeed = Math.min(2, Math.max(0.5, Number(speed) || 1));
  const parts = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const buf = await fetchSpeechChunk(chunks[i], tl, safeSpeed);
    parts.push(i === 0 ? buf : stripId3(buf));
  }
  return { buffer: Buffer.concat(parts), mime: 'audio/mpeg', engine: 'google-tts' };
}

/* ------------------------- sound effects -------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wavBuffer(samples, sampleRate = 44100) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pickProfile(prompt) {
  const p = prompt.toLowerCase();
  if (/thunder|storm|rumble/.test(p)) return 'thunder';
  if (/rain|drizzle|shower/.test(p)) return 'rain';
  if (/wind|breeze|gust/.test(p)) return 'wind';
  if (/ocean|wave|sea|beach/.test(p)) return 'ocean';
  if (/whoosh|swoosh|sweep|pass by|transition/.test(p)) return 'whoosh';
  if (/fire|crackle|flame|campfire/.test(p)) return 'fire';
  if (/bell|chime|ding|temple/.test(p)) return 'chime';
  if (/beep|alarm|notify|notification|ping/.test(p)) return 'beep';
  if (/drum|kick|thump|beat/.test(p)) return 'drum';
  if (/laser|zap|sci-?fi|alien/.test(p)) return 'laser';
  if (/click|tap|pop/.test(p)) return 'click';
  return 'pad';
}

export function proceduralSound(prompt, durationSeconds = 5) {
  const duration = Math.min(10, Math.max(1, Number(durationSeconds) || 5));
  const rate = 44100;
  const total = Math.floor(rate * duration);
  const out = new Float32Array(total);
  let seed = 0;
  for (let i = 0; i < prompt.length; i += 1) seed = (seed * 31 + prompt.charCodeAt(i)) >>> 0;
  const rand = mulberry32(seed || 7);
  const profile = pickProfile(prompt);

  let lp1 = 0;
  let lp2 = 0;
  const noise = () => rand() * 2 - 1;

  for (let i = 0; i < total; i += 1) {
    const t = i / rate;
    const progress = t / duration;
    const n = noise();
    let sample = 0;

    switch (profile) {
      case 'rain': {
        lp1 += 0.25 * (n - lp1);
        sample = lp1 * 0.55 + n * 0.12;
        sample *= 0.7 + 0.15 * Math.sin(2 * Math.PI * 0.4 * t);
        break;
      }
      case 'thunder': {
        lp2 += 0.02 * (n - lp2);
        const env = Math.exp(-3.2 * progress) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t));
        sample = lp2 * 3.2 * env;
        break;
      }
      case 'wind': {
        lp1 += 0.02 * (n - lp1);
        sample = lp1 * 2.4 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 0.18 * t));
        break;
      }
      case 'ocean': {
        lp1 += 0.015 * (n - lp1);
        const swell = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 0.14 * t - Math.PI / 2)) + 0.15, 1.6);
        sample = lp1 * 3.6 * swell;
        break;
      }
      case 'whoosh': {
        const cutoff = 0.01 + 0.35 * Math.sin(Math.PI * progress);
        lp1 += cutoff * (n - lp1);
        const env = Math.sin(Math.PI * progress);
        sample = lp1 * 1.8 * env;
        break;
      }
      case 'fire': {
        lp1 += 0.4 * (n - lp1);
        sample = lp1 * 0.22;
        if (rand() < 0.0016) sample += (rand() * 2 - 1) * 0.75;
        break;
      }
      case 'chime': {
        const partials = [523.25, 784, 1046.5, 1568];
        const env = Math.exp(-2.4 * progress);
        sample = partials.reduce((acc, f, idx) => acc + Math.sin(2 * Math.PI * f * t) / (idx + 1.6), 0) * 0.28 * env;
        break;
      }
      case 'beep': {
        const tone = Math.floor(t / 0.28) % 2 === 0 ? 880 : 660;
        const env = Math.exp(-6 * ((t % 0.28) / 0.28));
        sample = Math.sin(2 * Math.PI * tone * t) * 0.4 * env;
        break;
      }
      case 'drum': {
        const beat = t % 0.5;
        const env = Math.exp(-16 * beat);
        const freq = 130 * Math.exp(-9 * beat) + 45;
        sample = Math.sin(2 * Math.PI * freq * beat) * 0.75 * env;
        break;
      }
      case 'laser': {
        const freq = 1800 * Math.exp(-3 * progress) + 120;
        sample = Math.sin(2 * Math.PI * freq * t) * 0.32 * Math.exp(-1.6 * progress);
        break;
      }
      case 'click': {
        const clickEnv = Math.exp(-60 * (t % 0.25));
        sample = (n * 0.5 + Math.sin(2 * Math.PI * 1200 * t) * 0.5) * 0.4 * clickEnv;
        break;
      }
      default: {
        const env = Math.min(1, t / 0.35) * Math.min(1, (duration - t) / 0.6);
        sample =
          (Math.sin(2 * Math.PI * 220 * t) * 0.22 +
            Math.sin(2 * Math.PI * 329.63 * t) * 0.18 +
            Math.sin(2 * Math.PI * 440 * t) * 0.14 +
            lp1 * 0.05) *
          env;
        lp1 += 0.08 * (n - lp1);
        break;
      }
    }

    out[i] = Math.tanh(sample * 1.1);
  }

  // short fade in/out to avoid clicks
  const fade = Math.min(1024, Math.floor(total / 20));
  for (let i = 0; i < fade; i += 1) {
    out[i] *= i / fade;
    out[total - 1 - i] *= i / fade;
  }

  return { buffer: wavBuffer(out, rate), mime: 'audio/wav', engine: `local-synth:${profile}` };
}

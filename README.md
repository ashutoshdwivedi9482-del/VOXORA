# VOXORA — AI Voice Studio

A single-service web app: React (Vite) frontend + Express API, one public URL.

## Features

- **Accounts** — register, sign in, persistent sessions (scrypt password hashing, signed tokens)
- **Text to speech** — free Google speech engine by default (no API key), ElevenLabs when a key is configured
- **Voice library** — multilingual voices with real audio previews and favourites
- **Speech to text** — in-browser microphone transcription (no key) + server Whisper when `OPENAI_API_KEY` is set
- **Sound effects** — procedural audio synthesis, so it works with zero paid credits
- **History** — every generation stored per user with playback, download and delete
- **Favourites** — saved voices, persisted per account

## Run locally

```bash
npm install
npm run build    # build the React client into dist/
npm start        # serves dist/ and /api on http://localhost:3000
```

Development with hot reload:

```bash
npm start            # API on :3000
npm run dev          # Vite on :5173, proxies /api to :3000
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | create account, returns token |
| POST | `/api/auth/login` | sign in, returns token |
| GET | `/api/auth/me` | current user |
| GET | `/api/health` | engine + storage status |
| GET | `/api/voices` | voice library |
| GET | `/api/voices/:id/preview` | voice preview MP3 |
| POST | `/api/tts` | generate speech |
| POST | `/api/transcribe` | save transcript, or transcribe uploaded audio with a key |
| POST | `/api/sound-effects` | generate sound effect |
| GET/DELETE | `/api/history`, `/api/history/:id` | list/delete generations |
| GET/POST | `/api/favourites` | list/toggle favourites |

## Configuration

All optional — the app is fully functional with no keys.

| Variable | Effect |
| --- | --- |
| `PORT` | HTTP port (default 3000, set by hosting) |
| `DATA_DIR` | storage directory (default `./data`) |
| `JWT_SECRET` | token signing secret (auto-generated and persisted if absent) |
| `ELEVENLABS_API_KEY` | use ElevenLabs voices for TTS instead of the free engine |
| `OPENAI_API_KEY` | enables Whisper transcription of uploaded audio files |

## Notes

Storage is a file-backed database inside the app directory. It persists across restarts and
redeploys that keep the same disk; the free hosting plan has no persistent volume, so a full
container rebuild starts with an empty database. Guests re-register after such a rebuild.

# VOXORA — Full-stack AI Voice Studio

A full-stack starter for an AI voice workspace with:
- Text-to-speech generation (ElevenLabs)
- Voice discovery and preview
- Speech-to-text transcription (OpenAI Whisper API)
- Sound effects generation (ElevenLabs)
- JWT authentication
- SQLite-backed users, favourites and generation history
- MP3/audio playback and download
- Responsive React dashboard

## Requirements
- Node.js 18+
- Python 3.10+
- ElevenLabs API key
- (Optional) OpenAI API key for transcription

## 1. Backend setup
```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Add your API keys in .env
python app.py
```
Backend runs at http://localhost:5000.

## 2. Frontend setup
Open a second terminal:
```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```
Frontend runs at http://localhost:5173.

## Environment variables
Backend `.env`:
- `SECRET_KEY`: long random secret
- `ELEVENLABS_API_KEY`: required for real TTS, voice list, sound effects
- `OPENAI_API_KEY`: optional, required for Whisper transcription
- `FRONTEND_ORIGIN`: frontend URL

Frontend `.env`:
- `VITE_API_URL=http://localhost:5000/api`

## Deploy
- Push this folder to GitHub.
- Deploy `backend/` to Render as a Python web service; build command `pip install -r requirements.txt`, start command `gunicorn app:app`.
- Deploy `frontend/` to Vercel; framework Vite, root directory `frontend`, build command `npm run build`, output `dist`.
- Set environment variables on both services. Set frontend `VITE_API_URL` to your deployed backend `/api` URL and backend `FRONTEND_ORIGIN` to your Vercel URL.
- Use a persistent disk for `backend/uploads` and `backend/generated` if you want uploaded/generated files to survive redeploys. SQLite is suitable for a demo/small project; use PostgreSQL for production/multiple backend instances.

## Important
This is complete runnable source code, but real AI generation requires your own provider API keys. API keys stay on the backend and must never be placed in frontend code. The starter uses an explicit consent checkbox for audio uploads and does not implement voice cloning.

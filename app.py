import os, uuid
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, get_jwt_identity
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
import requests

load_dotenv()
BASE = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE, "uploads")
OUTPUT_DIR = os.path.join(BASE, "generated")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-change-me")
app.config["JWT_SECRET_KEY"] = os.getenv("JWT_SECRET_KEY", "dev-jwt-change-me")
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(BASE, "voxora.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(days=2)
CORS(app, origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")])
db = SQLAlchemy(app)
jwt = JWTManager(app)

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    email = db.Column(db.String(160), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Generation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    kind = db.Column(db.String(30), nullable=False)
    title = db.Column(db.String(180), nullable=False)
    text = db.Column(db.Text)
    voice_id = db.Column(db.String(120))
    file_name = db.Column(db.String(255))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Favourite(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    voice_id = db.Column(db.String(120), nullable=False)
    voice_name = db.Column(db.String(120), nullable=False)
    __table_args__ = (db.UniqueConstraint("user_id", "voice_id"),)

def api_error(message, status=400):
    return jsonify({"error": message}), status

def eleven_headers():
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is missing. Add it to backend/.env.")
    return {"xi-api-key": key}

@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "VOXORA API"})

@app.post("/api/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    name, email, password = (data.get("name") or "").strip(), (data.get("email") or "").lower().strip(), data.get("password") or ""
    if not name or not email or len(password) < 8:
        return api_error("Name, valid email and password (at least 8 characters) are required.")
    if User.query.filter_by(email=email).first():
        return api_error("An account with this email already exists.", 409)
    user = User(name=name, email=email, password=generate_password_hash(password))
    db.session.add(user); db.session.commit()
    token = create_access_token(identity=str(user.id))
    return jsonify({"token": token, "user": {"id": user.id, "name": user.name, "email": user.email}}), 201

@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    user = User.query.filter_by(email=(data.get("email") or "").lower().strip()).first()
    if not user or not check_password_hash(user.password, data.get("password") or ""):
        return api_error("Incorrect email or password.", 401)
    return jsonify({"token": create_access_token(identity=str(user.id)), "user": {"id": user.id, "name": user.name, "email": user.email}})

@app.get("/api/auth/me")
@jwt_required()
def me():
    user = db.session.get(User, int(get_jwt_identity()))
    if not user: return api_error("User not found.", 404)
    return jsonify({"id": user.id, "name": user.name, "email": user.email})

@app.get("/api/voices")
def voices():
    try:
        r = requests.get("https://api.elevenlabs.io/v1/voices", headers=eleven_headers(), timeout=25)
        r.raise_for_status()
        items = r.json().get("voices", [])
        return jsonify([{"voice_id": v["voice_id"], "name": v["name"], "category": v.get("category", "default"),
                         "preview_url": v.get("preview_url"), "labels": v.get("labels", {})} for v in items])
    except Exception as e:
        return api_error(str(e), 502)

@app.post("/api/tts")
@jwt_required()
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    voice_id = (data.get("voice_id") or "").strip()
    if not text or not voice_id: return api_error("Text and voice are required.")
    if len(text) > 5000: return api_error("Text limit is 5,000 characters.")
    settings = data.get("settings") or {}
    payload = {"text": text, "model_id": "eleven_multilingual_v2",
               "voice_settings": {"stability": float(settings.get("stability", .5)),
                                  "similarity_boost": float(settings.get("similarity", .75)),
                                  "style": float(settings.get("style", 0)),
                                  "use_speaker_boost": True}}
    try:
        r = requests.post(f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                          headers={**eleven_headers(), "Content-Type": "application/json", "Accept": "audio/mpeg"},
                          json=payload, timeout=120)
        r.raise_for_status()
        filename = f"{uuid.uuid4().hex}.mp3"
        with open(os.path.join(OUTPUT_DIR, filename), "wb") as f: f.write(r.content)
        item = Generation(user_id=int(get_jwt_identity()), kind="tts", title=text[:70],
                          text=text, voice_id=voice_id, file_name=filename)
        db.session.add(item); db.session.commit()
        return jsonify({"id": item.id, "audio_url": f"/api/files/{filename}", "download_url": f"/api/files/{filename}?download=1"})
    except Exception as e:
        return api_error(f"Speech generation failed: {e}", 502)

@app.post("/api/transcribe")
@jwt_required()
def transcribe():
    if "audio" not in request.files: return api_error("Choose an audio file.")
    f = request.files["audio"]
    if not f.filename: return api_error("Invalid file.")
    if not os.getenv("OPENAI_API_KEY"): return api_error("OPENAI_API_KEY is not configured for transcription.", 503)
    name = secure_filename(f.filename)
    path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{name}")
    f.save(path)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        with open(path, "rb") as audio:
            result = client.audio.transcriptions.create(model="whisper-1", file=audio)
        text = result.text
        item = Generation(user_id=int(get_jwt_identity()), kind="transcription", title=name, text=text)
        db.session.add(item); db.session.commit()
        return jsonify({"text": text, "id": item.id})
    except Exception as e:
        return api_error(f"Transcription failed: {e}", 502)
    finally:
        if os.path.exists(path): os.remove(path)

@app.post("/api/sound-effects")
@jwt_required()
def sound_effects():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt: return api_error("Describe the sound you want.")
    try:
        r = requests.post("https://api.elevenlabs.io/v1/sound-generation",
            headers={**eleven_headers(), "Content-Type": "application/json", "Accept": "audio/mpeg"},
            json={"text": prompt, "duration_seconds": min(max(float(data.get("duration", 5)), 0.5), 22),
                  "prompt_influence": 0.3}, timeout=120)
        r.raise_for_status()
        filename = f"{uuid.uuid4().hex}.mp3"
        with open(os.path.join(OUTPUT_DIR, filename), "wb") as out: out.write(r.content)
        item = Generation(user_id=int(get_jwt_identity()), kind="sound", title=prompt[:70], text=prompt, file_name=filename)
        db.session.add(item); db.session.commit()
        return jsonify({"id": item.id, "audio_url": f"/api/files/{filename}"})
    except Exception as e:
        return api_error(f"Sound generation failed: {e}", 502)

@app.get("/api/files/<path:filename>")
def get_file(filename):
    # Generated filenames are random UUIDs; do not expose arbitrary filesystem paths.
    if "/" in filename or "\\" in filename: return api_error("Invalid filename.", 400)
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=request.args.get("download") == "1")

@app.get("/api/history")
@jwt_required()
def history():
    rows = Generation.query.filter_by(user_id=int(get_jwt_identity())).order_by(Generation.created_at.desc()).limit(100).all()
    return jsonify([{"id": x.id, "kind": x.kind, "title": x.title, "text": x.text,
                     "voice_id": x.voice_id, "audio_url": f"/api/files/{x.file_name}" if x.file_name else None,
                     "created_at": x.created_at.isoformat()} for x in rows])

@app.get("/api/favourites")
@jwt_required()
def get_favourites():
    rows = Favourite.query.filter_by(user_id=int(get_jwt_identity())).all()
    return jsonify([{"voice_id": x.voice_id, "name": x.voice_name} for x in rows])

@app.post("/api/favourites")
@jwt_required()
def add_favourite():
    data = request.get_json(silent=True) or {}
    vid, name = data.get("voice_id"), data.get("name")
    if not vid or not name: return api_error("Voice ID and name are required.")
    uid = int(get_jwt_identity())
    row = Favourite.query.filter_by(user_id=uid, voice_id=vid).first()
    if row: db.session.delete(row)
    else: db.session.add(Favourite(user_id=uid, voice_id=vid, voice_name=name))
    db.session.commit()
    return jsonify({"saved": row is None})

@app.delete("/api/history/<int:item_id>")
@jwt_required()
def delete_history(item_id):
    row = Generation.query.filter_by(id=item_id, user_id=int(get_jwt_identity())).first()
    if not row: return api_error("History item not found.", 404)
    if row.file_name:
        path = os.path.join(OUTPUT_DIR, row.file_name)
        if os.path.exists(path): os.remove(path)
    db.session.delete(row); db.session.commit()
    return jsonify({"deleted": True})

with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)

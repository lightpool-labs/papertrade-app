"""Song-driven PaperTrade demo sidecar.

Upload an MP3 -> librosa analysis -> session + timeline on disk.
The Next.js trade page replays the timeline in demo mode. No chain access.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from analyze import build_timeline, default_seed, load_audio

DATA_DIR = Path(os.environ.get("PAPER_DEMO_DATA", Path(__file__).parent / "data"))
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
SESSION_RE = re.compile(r"^[0-9a-f]{16}$")

app = FastAPI(title="papertrade song demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def session_dir(sid: str) -> Path:
    if not SESSION_RE.match(sid):
        raise HTTPException(404, "unknown session")
    path = DATA_DIR / sid
    if not path.is_dir():
        raise HTTPException(404, "unknown session")
    return path


@app.post("/api/demo/sessions")
async def create_session(
    song: UploadFile = File(...),
    symbol: str = Form("btc"),
    seed: int | None = Form(None),
) -> JSONResponse:
    raw = await song.read()
    if not raw:
        raise HTTPException(400, "empty song")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "song too large (max 30 MB)")
    name = (song.filename or "").lower()
    ctype = (song.content_type or "").lower()
    if not (name.endswith(".mp3") or "mpeg" in ctype or "mp3" in ctype):
        raise HTTPException(400, "song must be an mp3")

    sym = (symbol or "btc").strip().lower() or "btc"
    use_seed = seed if seed is not None else default_seed(raw)

    sid = secrets.token_hex(8)
    path = DATA_DIR / sid
    path.mkdir(parents=True, exist_ok=False)
    song_path = path / "song.mp3"
    song_path.write_bytes(raw)
    try:
        y, sr = load_audio(song_path)
        timeline = build_timeline(sym, y, sr, use_seed)
    except Exception as exc:
        shutil.rmtree(path, ignore_errors=True)
        raise HTTPException(500, f"failed to analyze song: {exc}") from exc

    session = {
        "session_id": sid,
        "symbol": sym,
        "duration": timeline["duration"],
        "climax_at": timeline["climax_at"],
        "sample_hz": timeline["sample_hz"],
        "seed": use_seed,
        "song_url": f"/api/demo/sessions/{sid}/song",
        "timeline_url": f"/api/demo/sessions/{sid}/timeline",
    }
    (path / "session.json").write_text(json.dumps(session, indent=2))
    (path / "timeline.json").write_text(json.dumps(timeline))
    return JSONResponse(
        {
            "session_id": sid,
            "duration": session["duration"],
            "climax_at": session["climax_at"],
            "sample_hz": session["sample_hz"],
            "song_url": session["song_url"],
        }
    )


@app.get("/api/demo/sessions/{sid}")
def get_session(sid: str) -> dict:
    path = session_dir(sid)
    return json.loads((path / "session.json").read_text())


@app.get("/api/demo/sessions/{sid}/timeline")
def get_timeline(sid: str) -> dict:
    path = session_dir(sid)
    return json.loads((path / "timeline.json").read_text())


@app.get("/api/demo/sessions/{sid}/song")
def get_song(sid: str, range_header: str | None = Header(None, alias="range")) -> Response:
    path = session_dir(sid)
    data = (path / "song.mp3").read_bytes()
    total = len(data)
    base_headers = {"Accept-Ranges": "bytes"}
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
        if m:
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else total - 1
            end = min(end, total - 1)
            if start > end or start >= total:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{total}"},
                )
            chunk = data[start : end + 1]
            return Response(
                content=chunk,
                status_code=206,
                media_type="audio/mpeg",
                headers={
                    **base_headers,
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Content-Length": str(len(chunk)),
                },
            )
    return Response(content=data, media_type="audio/mpeg", headers=base_headers)

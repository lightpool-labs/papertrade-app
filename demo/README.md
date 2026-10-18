# Song-driven PaperTrade demo

Upload an MP3, analyze its energy with librosa, and replay a deterministic
fake mark/liquidation timeline on `/trade/btc?demo=<session_id>` so the
existing Fireworks / liquidation-ash UI erupts at the song climax. No chain,
no indexer, no wallet transactions. Design: `../../tools/paper/demo.md`.

## Start the sidecar

Python 3.11+:

```bash
cd demo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8090
```

Sessions are stored under `demo/data/<session_id>/` (`song.mp3`,
`session.json`, `timeline.json`). Override with `PAPER_DEMO_DATA`.

## Analyze a song

```bash
curl -F "song=@track.mp3" -F "symbol=btc" \
  http://127.0.0.1:8090/api/demo/sessions
# => {"session_id":"...","duration":180.2,"climax_at":72.4,"sample_hz":20,"song_url":"..."}
```

Same file bytes get the same default seed, and the same seed reproduces the
same timeline (`seed` is persisted in `session.json`; pass `-F seed=123` to
force one).

## Run the frontend demo

```bash
cd frontend
NEXT_PUBLIC_DEMO_API=http://127.0.0.1:8090 npm run dev
```

Open `http://127.0.0.1:3000/trade/btc?demo=<session_id>`:

- The page disconnects the live oracle mark / indexer feeds and drives the
  tick chart from the timeline, clocked by `<audio>.currentTime`.
- Before the climax the banner tape is mostly opens/closes; liquidations only
  pop on sharp price moves. Fireworks are forced on: every liquidation calls
  `launchLiqdAsh` directly (liq chips throttled), so the climax window
  (80–200 liqs/sec) floods ash without depending on the banner queue.
- Demo panel: Play / Pause / Seek / Jump to climax / download timeline.

Without `NEXT_PUBLIC_DEMO_API`, `?demo=` shows "demo API not configured".
Without `?demo=`, `/trade/btc` is unchanged (live feeds).

The Rust backend / indexer do not need to run for the demo: when the markets
request fails in demo mode, the page falls back to a synthetic BTC market
instead of showing an error banner, and account/position polling is skipped.

## Record

Jump to climax, press Play, capture with OBS. Seeking backward resets the
emitted set, so retakes fire the same liquidations again.

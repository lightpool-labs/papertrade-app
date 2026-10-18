"""MP3 -> replayable demo timeline (marks + liquidations).

Deterministic: same audio features + same seed => identical timeline.
All tunables live here so two machines with the same librosa features agree.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np

ANCHOR_PRICE = 81_525.0
SAMPLE_HZ = 20
LOAD_SR = 22_050

# Energy envelope.
ENERGY_SMOOTH_S = 0.5
CLIMAX_SCAN_S = 4.0
# The max-energy window center lags the musical drop; nudge it earlier.
CLIMAX_BACK_S = 1.0
# A quiet gap this long splits the song. Each piece gets a climax at its end.
SEGMENT_QUIET = 0.30
SEGMENT_GAP_S = 1.4
SEGMENT_MIN_S = 8.0
CLIMAX_TAIL = 0.28
DUMP_ACTIVE_S = 3.2

# Marks. Before the drop: irregular mean-reverting tape (not a drawn wave).
# Then the climax dump.
PRE_RISE = 0.0
# Tight around the anchor so the tape does not grind out lower lows
# before the climb. The climb head should be the move you see.
WAVE_REVERT = 0.8
WAVE_SIGMA = 0.0011
SMOOTH_S = 1.2
SLOW_ONSET = 0.35
SLOW_FLAT = 0.10
# Leave the flat slowly, then tire out into the top. Not a straight line.
CLIMB_S = 12.0
CLIMB_HOLD_S = 0.95
CLIMB_HEIGHT = 0.00032
CLIMB_SIGMA = 0.0
CLIMB_PEAK_U = 0.05
CLIMB_FLOOR = 0.42
CLIMB_DECAY = 1.15
DROP_LEAD_S = 0.0
DROP_TAU_S = 0.5
# Three drops. The first is a small step. The third is the fall to the bottom.
DROP_LEG_S = (0.55, 0.38, 0.24)
DROP_GAP_S = 0.07
DROP_LEG_DEPTH = (0.0012, 0.005, 0.20)
CRASH_SIGMA = 0.012
CRASH_SIGMA_TAU_S = 2.0
# Post-crash tape is exhausted: quieter waves, so the liq triggers stay silent.
POST_WAVE_SCALE = 0.3
AFTER_DRIFT = 0.0003

# Activity (opens / closes), per second. Pre-climax tape is mostly these.
OPEN_RATE_MIN = 0.8
OPEN_RATE_SPAN = 2.2
CLOSE_RATE_MIN = 0.5
CLOSE_RATE_SPAN = 1.5
CLIMAX_ACTIVITY_SCALE = 0.25
MARGIN_MEDIAN = 120.0
MARGIN_SIGMA = 1.3
MARGIN_MIN = 10.0
MARGIN_MAX = 500_000.0
P_LONG_OPEN = 0.55
P_WIN_CLOSE = 0.35

# Boats run for the whole leg between beats, so the tape does not go quiet.
BEAT_RATE = 14.0

# Climax liquidation burst: starts as the dump begins, ends when the price
# has bottomed, so every boat fires while the price is falling.
CLIMAX_LEAD_S = 0.0
CLIMAX_WINDOW_S = 1.8
CLIMAX_RATE_MIN = 50.0
CLIMAX_RATE_SPAN = 0.0
LOSS_MEDIAN = 200.0
LOSS_SIGMA = 1.6
LOSS_MIN = 5.0
LOSS_MAX = 2_000_000.0
P_LONG_CLIMAX = 0.85


def default_seed(song_bytes: bytes) -> int:
    digest = hashlib.sha256(song_bytes).digest()
    return int.from_bytes(digest[:8], "big") % (2**31)


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """Decode to mono 22.05kHz. Falls back to ffmpeg when soundfile cannot."""
    try:
        y, sr = librosa.load(str(path), sr=LOAD_SR, mono=True)
        return y, sr
    except Exception:
        if not shutil.which("ffmpeg"):
            raise
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = Path(tmp.name)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), str(wav)],
            check=True,
            capture_output=True,
        )
        y, sr = librosa.load(str(wav), sr=LOAD_SR, mono=True)
        return y, sr
    finally:
        wav.unlink(missing_ok=True)


def energy_envelope(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    if len(rms) == 0:
        return times, rms
    win = max(1, int(round(ENERGY_SMOOTH_S * sr / hop)))
    smooth = np.convolve(rms, np.ones(win) / win, mode="same")
    lo = float(smooth.min())
    hi = float(smooth.max())
    if hi - lo < 1e-9:
        return times, np.zeros_like(smooth)
    return times, (smooth - lo) / (hi - lo)


def find_climaxes(times: np.ndarray, energy: np.ndarray, duration: float) -> list[float]:
    """One climax near the end. A long quiet gap splits the song, and each
    piece gets its own climax at the end of that piece."""
    if len(energy) == 0 or duration <= 0:
        return [max(1.0, duration * 0.85)]
    quiet = energy < SEGMENT_QUIET
    mids: list[float] = []
    i = 0
    while i < len(quiet):
        if not quiet[i]:
            i += 1
            continue
        j = i + 1
        while j < len(quiet) and quiet[j]:
            j += 1
        t0 = float(times[i])
        t1 = float(times[min(j, len(times) - 1)])
        if (t1 - t0) >= SEGMENT_GAP_S and t0 > 3.0 and t1 < duration - 3.0:
            mids.append((t0 + t1) / 2)
        i = j
    bounds = [0.0, *mids, duration]
    climaxes: list[float] = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a < SEGMENT_MIN_S:
            continue
        mask = (times >= a) & (times <= b)
        seg_t = times[mask]
        seg_e = energy[mask]
        if len(seg_t) == 0:
            continue
        tail_from = a + (b - a) * (1.0 - CLIMAX_TAIL)
        tail_t = seg_t[seg_t >= tail_from]
        tail_e = seg_e[seg_t >= tail_from]
        if len(tail_t) == 0:
            continue
        peak = float(tail_e.max())
        hot = np.where(tail_e >= max(0.45, peak * 0.92))[0]
        center = float(tail_t[hot[-1]] if len(hot) else tail_t[int(np.argmax(tail_e))])
        climaxes.append(min(max(center - CLIMAX_BACK_S, a + 1.0), b - 0.4))
    if not climaxes:
        climaxes = [max(1.0, duration - 4.0)]
    merged: list[float] = []
    for c in climaxes:
        if merged and c - merged[-1] < 6.0:
            merged[-1] = c
        else:
            merged.append(c)
    return merged


def find_climax(times: np.ndarray, energy: np.ndarray, duration: float) -> float:
    """The last climax. Playback jumps here."""
    return find_climaxes(times, energy, duration)[-1]


def onset_speed(y: np.ndarray, sr: int, ts: np.ndarray) -> np.ndarray:
    """0 = sparse beat, 1 = busy beat."""
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    ot = librosa.times_like(onset, sr=sr)
    if len(ot) == 0:
        return np.full(len(ts), 0.5)
    env = np.interp(ts, ot, onset, left=float(onset[0]), right=float(onset[-1]))
    win = max(3, int(round(2.0 * SAMPLE_HZ)) | 1)
    env = np.convolve(env, np.ones(win) / win, mode="same")
    lo = float(np.quantile(env, 0.15))
    hi = float(np.quantile(env, 0.85))
    if hi - lo < 1e-8:
        return np.full(len(ts), 0.5)
    return np.clip((env - lo) / (hi - lo), 0.0, 1.0)


def build_marks(
    ts: np.ndarray,
    climaxes: list[float],
    speed: np.ndarray,
    rng: np.random.Generator,
) -> tuple[list[dict], np.ndarray]:
    """Mean-reverting tape. Each climax is a climb, then a dump that starts
    on the climax. After a dump the price reverts so a later segment can climb again."""
    dt = 1.0 / SAMPLE_HZ
    n = len(ts)
    anchor = np.log(ANCHOR_PRICE)
    noise = rng.standard_normal(n)
    logret = np.zeros(n)

    leg_mu = tuple(-depth / length for depth, length in zip(DROP_LEG_DEPTH, DROP_LEG_S))

    def drop_mu(t: float) -> float | None:
        chosen: float | None = None
        chosen_left: float | None = None
        for c in climaxes:
            cursor = c - DROP_LEAD_S
            if t <= cursor:
                continue
            for length, mu in zip(DROP_LEG_S, leg_mu):
                leg_end = cursor + length
                if cursor < t <= leg_end:
                    left = t - cursor
                    if chosen_left is None or left < chosen_left:
                        chosen = mu
                        chosen_left = left
                    break
                cursor = leg_end + DROP_GAP_S
                if cursor - DROP_GAP_S < t <= cursor:
                    if chosen_left is None or (t - (cursor - DROP_GAP_S)) < chosen_left:
                        chosen = 0.0
                        chosen_left = t - (cursor - DROP_GAP_S)
                    break
        return chosen

    def drops_end(c: float) -> float:
        cursor = c - DROP_LEAD_S
        for length in DROP_LEG_S:
            cursor += length + DROP_GAP_S
        return cursor - DROP_GAP_S

    final_drop_end = drops_end(climaxes[-1]) if climaxes else float(ts[-1])
    lift = float(np.log(1.0 + CLIMB_HEIGHT))
    climb_mu = np.full(n, np.nan)
    for c in climaxes:
        start = c - CLIMB_S
        move = start + CLIMB_HOLD_S
        hold = (ts >= start) & (ts < move)
        mask = (ts >= move) & (ts <= c)
        climb_mu[hold] = 0.0
        if not np.any(mask):
            continue
        span = max(c - move, 1e-6)
        u = np.clip((ts[mask] - move) / span, 0.0, 1.0)
        rise = u <= CLIMB_PEAK_U
        weight = np.empty(u.shape)
        weight[rise] = np.sin((u[rise] / CLIMB_PEAK_U) * (np.pi / 2))
        x = (u[~rise] - CLIMB_PEAK_U) / (1.0 - CLIMB_PEAK_U)
        weight[~rise] = CLIMB_FLOOR + (1.0 - CLIMB_FLOOR) * (1.0 - x) ** CLIMB_DECAY
        area = float(weight.sum() * dt)
        climb_mu[mask] = lift * weight / area

    x = anchor
    for i in range(1, n):
        t = float(ts[i])
        falling = drop_mu(t)
        mu_up = None if falling is not None or not np.isfinite(climb_mu[i]) else float(climb_mu[i])
        if falling is None and t > final_drop_end:
            logret[i] = -AFTER_DRIFT * dt
            x += logret[i]
        elif falling is None and mu_up is None:
            baseline = anchor + PRE_RISE * t
            step = WAVE_REVERT * (baseline - x) * dt + WAVE_SIGMA * np.sqrt(dt) * noise[i]
            logret[i] = step
            x += step
        elif falling is None:
            step = mu_up * dt + CLIMB_SIGMA * np.sqrt(dt) * noise[i]
            logret[i] = step
            x += step
        else:
            logret[i] = falling * dt
            x += logret[i]
    logpx = np.log(ANCHOR_PRICE) + np.cumsum(logret)
    # Smooth only before the grind. Smoothing the climb irons the top flat.
    climb_at = max(0.0, climaxes[0] - CLIMB_S) if climaxes else float(ts[-1])
    cut = int(np.searchsorted(ts, climb_at, side="right"))
    sigma = max(1.0, SMOOTH_S * SAMPLE_HZ)
    win = max(3, int(round(sigma * 6)) | 1)
    kernel = np.exp(-0.5 * (np.linspace(-(win // 2), win // 2, win) / sigma) ** 2)
    kernel /= kernel.sum()
    pad = win // 2
    raw_join = float(logpx[cut - 1]) if cut > 0 else float(logpx[0])
    head = np.pad(logpx[:cut], (pad, pad), mode="edge")
    logpx[:cut] = np.convolve(head, kernel, mode="valid")
    if 0 < cut < n:
        logpx[cut:] += float(logpx[cut - 1]) - raw_join
    slow = speed[:cut] < SLOW_ONSET
    gap = int(round(1.5 * SAMPLE_HZ))
    i = 0
    while i < cut:
        if slow[i]:
            i += 1
            continue
        j = i
        while j < cut and not slow[j]:
            j += 1
        if i > 0 and j < cut and (j - i) <= gap:
            slow[i:j] = True
        i = j
    i = 0
    while i < cut:
        if not slow[i]:
            i += 1
            continue
        j = i + 1
        while j < cut and slow[j]:
            j += 1
        hold = int(round(SLOW_FLAT * (j - i)))
        if hold >= 2:
            h0 = i + ((j - i) - hold) // 2
            logpx[h0 : h0 + hold] = logpx[h0]
        i = j
    logret = np.diff(logpx, prepend=logpx[0])
    px = ANCHOR_PRICE * np.exp(np.cumsum(logret))
    marks = [
        {"t": round(float(t), 3), "px": round(float(p), 1)} for t, p in zip(ts, px)
    ]
    return marks, logret


def draw_amount(rng: np.random.Generator, median: float, sigma: float, lo: float, hi: float) -> float:
    value = float(np.exp(rng.normal(np.log(median), sigma)))
    return min(max(value, lo), hi)


def pre_liq_events(
    ts: np.ndarray,
    logret: np.ndarray,
    drop_start: float,
    asset: str,
    rng: np.random.Generator,
    next_id,
) -> list[dict]:
    """Steady boats until the dump. Side follows the recent price move."""
    out: list[dict] = []
    span = max(drop_start, 0.0)
    count = max(1, int(round(BEAT_RATE * span)))
    look = max(1, int(round(1.5 * SAMPLE_HZ)))
    for k in range(count):
        t = (k + float(rng.uniform(0.2, 0.8))) * span / count
        if t >= drop_start:
            continue
        i = min(int(t * SAMPLE_HZ), len(logret) - 1)
        drift = float(logret[max(0, i - look) : i + 1].sum())
        out.append(
            {
                "t": round(t, 3),
                "id": next_id(),
                "kind": "liq",
                "asset": asset,
                "side": "short" if drift >= 0.0 else "long",
                "amount_usd": round(
                    draw_amount(rng, LOSS_MEDIAN, LOSS_SIGMA, LOSS_MIN, LOSS_MAX), 1
                ),
            }
        )
    return out


def build_events(
    duration: float,
    times: np.ndarray,
    energy: np.ndarray,
    climaxes: list[float],
    logret: np.ndarray,
    ts: np.ndarray,
    drop_start: float,
    symbol: str,
    rng: np.random.Generator,
) -> list[dict]:
    """Opens / closes are the steady tape; each 0.1% beat step busts a crowd
    and a flood rides the climax dump. One id counter across kinds."""
    events: list[dict] = []
    bin_s = 0.1
    nbins = int(duration / bin_s) + 1
    counter = 0
    asset = symbol.upper()

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return f"d{counter:06d}"

    for b in range(nbins):
        t0 = b * bin_s
        if t0 >= duration:
            break
        mid = t0 + bin_s / 2
        e = float(np.interp(mid, times, energy)) if len(times) else 0.0
        in_climax = any(
            (c - CLIMAX_LEAD_S) <= mid <= c + CLIMAX_WINDOW_S for c in climaxes
        )
        activity = CLIMAX_ACTIVITY_SCALE if in_climax else 1.0

        opens = int(rng.poisson((OPEN_RATE_MIN + OPEN_RATE_SPAN * e) * activity * bin_s))
        for _ in range(opens):
            events.append(
                {
                    "t": round(t0 + float(rng.uniform(0.0, bin_s)), 3),
                    "id": next_id(),
                    "kind": "open",
                    "asset": asset,
                    "side": "long" if float(rng.uniform()) < P_LONG_OPEN else "short",
                    "amount_usd": round(
                        draw_amount(rng, MARGIN_MEDIAN, MARGIN_SIGMA, MARGIN_MIN, MARGIN_MAX), 1
                    ),
                }
            )

        closes = int(rng.poisson((CLOSE_RATE_MIN + CLOSE_RATE_SPAN * e) * activity * bin_s))
        for _ in range(closes):
            amount = draw_amount(rng, MARGIN_MEDIAN, MARGIN_SIGMA, MARGIN_MIN, MARGIN_MAX)
            if float(rng.uniform()) < P_WIN_CLOSE:
                pnl = amount * float(np.exp(rng.normal(np.log(0.6), 0.8)))
            else:
                pnl = -amount * min(0.95, float(np.exp(rng.normal(np.log(0.45), 0.7))))
            events.append(
                {
                    "t": round(t0 + float(rng.uniform(0.0, bin_s)), 3),
                    "id": next_id(),
                    "kind": "close",
                    "asset": asset,
                    "side": "long" if float(rng.uniform()) < 0.5 else "short",
                    "amount_usd": round(amount, 1),
                    "pnl_usd": round(pnl, 1),
                }
            )

        if in_climax:
            liq_rate = CLIMAX_RATE_MIN + CLIMAX_RATE_SPAN * e
            for _ in range(int(rng.poisson(liq_rate * bin_s))):
                side = "long" if float(rng.uniform()) < P_LONG_CLIMAX else "short"
                events.append(
                    {
                        "t": round(t0 + float(rng.uniform(0.0, bin_s)), 3),
                        "id": next_id(),
                        "kind": "liq",
                        "asset": asset,
                        "side": side,
                        "amount_usd": round(
                            draw_amount(rng, LOSS_MEDIAN, LOSS_SIGMA, LOSS_MIN, LOSS_MAX), 1
                        ),
                    }
                )

    events.extend(pre_liq_events(ts, logret, drop_start, asset, rng, next_id))
    events.sort(key=lambda row: row["t"])
    return events


def build_timeline(
    symbol: str, y: np.ndarray, sr: int, seed: int
) -> dict:
    times, energy = energy_envelope(y, sr)
    duration = float(len(y) / sr)
    climaxes = find_climaxes(times, energy, duration)
    climax = climaxes[-1]
    rng = np.random.default_rng(seed)

    n = int(duration * SAMPLE_HZ) + 1
    ts = np.minimum(np.arange(n) / SAMPLE_HZ, duration)
    speed = onset_speed(y, sr, ts)
    marks, logret = build_marks(ts, climaxes, speed, rng)
    drop_start = max(0.0, climaxes[0] - DROP_LEAD_S)
    events = build_events(
        duration, times, energy, climaxes, logret, ts, drop_start, symbol, rng
    )

    return {
        "symbol": symbol,
        "duration": round(duration, 2),
        "climax_at": round(climax, 2),
        "sample_hz": SAMPLE_HZ,
        "marks": marks,
        "events": events,
    }

"""
FieldVision Processing Worker — Modal.com

Pipeline:
  1. Download left + right videos from R2
  2. Sync timestamps (audio cross-correlation)
  3. Stitch into panoramic video (FFmpeg side-by-side + seam blend)
  4. Run YOLOv8 ball + player detection on each frame
  5. Render tracking overlays, auto-zoom following ball
  6. Detect goal events (ball crosses goal-line region)
  7. Cut highlight clips
  8. Upload outputs to R2
  9. POST webhook to Vercel with results

Run locally:  modal run processing/worker.py
Deploy:       modal deploy processing/worker.py
"""

import os
import json
import time
import subprocess
import tempfile
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# Modal app & image
# ---------------------------------------------------------------------------

app = modal.App("field-vision")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "fastapi[standard]",
        "ultralytics==8.3.0",
        "opencv-python-headless==4.10.0.84",
        "boto3==1.35.0",
        "numpy==1.26.4",
        "scipy==1.14.0",
        "requests==2.32.3",
    )
)

# ---------------------------------------------------------------------------
# Secrets — set these in your Modal dashboard:
#   modal secret create field-vision-secrets \
#     R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
#     R2_BUCKET=... VERCEL_WEBHOOK_URL=... MODAL_AUTH_TOKEN=...
# ---------------------------------------------------------------------------

secrets = [modal.Secret.from_name("field-vision-secrets")]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _r2_client():
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _download(s3, key: str, dest: Path) -> None:
    s3.download_file(os.environ["R2_BUCKET"], key, str(dest))


def _upload(s3, src: Path, key: str) -> None:
    s3.upload_file(str(src), os.environ["R2_BUCKET"], key, ExtraArgs={"ContentType": "video/mp4"})


def _report(session_id: str, payload: dict) -> None:
    import requests
    url = os.environ["VERCEL_WEBHOOK_URL"]
    token = os.environ["MODAL_AUTH_TOKEN"]
    payload["session_id"] = session_id
    r = requests.post(url, json=payload, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Step 1 — Sync & Stitch
# ---------------------------------------------------------------------------

def _find_overlap(left_frame, right_frame) -> int:
    """
    Find the best overlap width between left and right frames by scanning
    candidate overlap amounts and picking the one with minimum pixel difference.
    Works on grass/uniform scenes where feature matching fails.
    Returns overlap in pixels.
    """
    import cv2
    import numpy as np

    h, w = left_frame.shape[:2]
    # Downsample for speed
    scale = 0.25
    small_l = cv2.resize(left_frame, None, fx=scale, fy=scale)
    small_r = cv2.resize(right_frame, None, fx=scale, fy=scale)
    sw = int(w * scale)

    best_overlap = int(w * 0.20)
    best_score = float("inf")

    # Try overlap fractions from 10% to 40%
    for frac in [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]:
        op = int(sw * frac)
        left_strip  = small_l[:, sw - op:].astype(np.float32)
        right_strip = small_r[:, :op].astype(np.float32)
        if left_strip.shape != right_strip.shape:
            continue
        score = np.mean(np.abs(left_strip - right_strip))
        if score < best_score:
            best_score = score
            best_overlap = int(w * frac)

    return best_overlap


def sync_and_stitch(left_path: Path, right_path: Path, out_path: Path) -> None:
    """
    Panoramic stitch using pixel-similarity overlap detection + gradient seam blend.
    More robust than feature matching on low-texture scenes (grass fields).
    """
    import cv2
    import numpy as np

    cap_l = cv2.VideoCapture(str(left_path))
    cap_r = cv2.VideoCapture(str(right_path))

    fps = cap_l.get(cv2.CAP_PROP_FPS) or 25.0

    # Normalize both videos to the same resolution (use left as reference)
    w = int(cap_l.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap_l.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def read_resized(cap):
        ret, frame = cap.read()
        if not ret:
            return False, None
        if frame.shape[1] != w or frame.shape[0] != h:
            frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_LINEAR)
        return True, frame

    total = int(cap_l.get(cv2.CAP_PROP_FRAME_COUNT))

    # Sample 3 frames and average the detected overlap
    overlap_samples = []
    for sample_pos in [0.3, 0.5, 0.7]:
        fidx = int(total * sample_pos)
        cap_l.set(cv2.CAP_PROP_POS_FRAMES, fidx)
        cap_r.set(cv2.CAP_PROP_POS_FRAMES, fidx)
        ret_l, fl = read_resized(cap_l)
        ret_r, fr = read_resized(cap_r)
        if ret_l and ret_r:
            overlap_samples.append(_find_overlap(fl, fr))

    overlap_px = int(sum(overlap_samples) / len(overlap_samples)) if overlap_samples else int(w * 0.20)
    out_w = w + (w - overlap_px)
    out_h = h

    # Reset to start
    cap_l.set(cv2.CAP_PROP_POS_FRAMES, 0)
    cap_r.set(cv2.CAP_PROP_POS_FRAMES, 0)

    seam_start = w - overlap_px
    alpha_blend = np.linspace(1, 0, overlap_px, dtype=np.float32)[np.newaxis, :]

    tmp_out = out_path.with_suffix(".raw.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(tmp_out), fourcc, fps, (out_w, out_h))

    while True:
        ret_l, frame_l = read_resized(cap_l)
        ret_r, frame_r = read_resized(cap_r)
        if not ret_l or not ret_r:
            break

        canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)

        # Left portion: solid left frame
        canvas[:, :seam_start] = frame_l[:, :seam_start]
        # Right portion: right frame shifted to fill remaining canvas
        canvas[:, w:] = frame_r[:, overlap_px:overlap_px + (out_w - w)]
        # Seam blend zone: gradient from left → right
        for c in range(3):
            l_seam = frame_l[:, seam_start:w, c].astype(np.float32)
            r_seam = frame_r[:, :overlap_px, c].astype(np.float32)
            canvas[:, seam_start:w, c] = (l_seam * alpha_blend + r_seam * (1 - alpha_blend)).astype(np.uint8)

        writer.write(canvas)

    cap_l.release()
    cap_r.release()
    writer.release()

    # Re-mux with audio from left camera
    cmd = [
        "ffmpeg", "-y",
        "-i", str(tmp_out),
        "-i", str(left_path),
        "-map", "0:v", "-map", "1:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    tmp_out.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Step 2 — Ball & Player tracking
# ---------------------------------------------------------------------------

def run_tracking(input_path: Path, output_path: Path, session_id: str) -> list[dict]:
    """
    Runs YOLOv8 detection on each frame, draws bounding boxes,
    applies auto-zoom window following the ball, and returns goal events.
    """
    import cv2
    import numpy as np
    from ultralytics import YOLO

    model = YOLO("yolov8s.pt")  # small — better small-object detection than nano

    cap = cv2.VideoCapture(str(input_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    tmp_out = output_path.with_suffix(".tmp.mp4")
    writer = cv2.VideoWriter(str(tmp_out), fourcc, fps, (w, h))

    # Viewport for auto-zoom (follows ball)
    zoom_x, zoom_y = w // 2, h // 2
    zoom_w, zoom_h = w, h  # starts at full frame
    ZOOM_W_TARGET = w // 2   # zoom window width when ball is detected
    ZOOM_LERP = 0.08          # smooth pan speed

    # Last known ball position for search-window fallback
    last_ball_cx: int | None = None
    last_ball_cy: int | None = None
    SEARCH_R = int(w * 0.15)  # search radius around last position (15% of width)

    goal_events: list[dict] = []
    frame_idx = 0

    # Goal-line x-positions (approximate for side-by-side stitch)
    # Left camera goal: x ~ w*0.07, Right camera goal: x ~ w*0.93
    GOAL_LEFT_X = int(w * 0.07)
    GOAL_RIGHT_X = int(w * 0.93)
    GOAL_BAND = int(w * 0.03)
    last_goal_frame = -int(fps * 5)  # debounce 5s

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        results = model(frame, verbose=False, classes=[0, 32])  # 0=person, 32=sports ball
        annotated = frame.copy()

        ball_cx, ball_cy = None, None

        # First pass — full frame
        for box in results[0].boxes:
            cls = int(box.cls[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

            if cls == 32:  # sports ball
                ball_cx, ball_cy = cx, cy
                cv2.circle(annotated, (cx, cy), 14, (0, 255, 80), 2)
                cv2.circle(annotated, (cx, cy), 4, (0, 255, 80), -1)

                # Goal detection
                if frame_idx - last_goal_frame > fps * 5:
                    if abs(cx - GOAL_LEFT_X) < GOAL_BAND:
                        ts = frame_idx / fps
                        goal_events.append({"label": "Goal (left net)", "start_sec": max(0, ts - 5), "end_sec": ts + 3, "frame": frame_idx})
                        last_goal_frame = frame_idx
                    elif abs(cx - GOAL_RIGHT_X) < GOAL_BAND:
                        ts = frame_idx / fps
                        goal_events.append({"label": "Goal (right net)", "start_sec": max(0, ts - 5), "end_sec": ts + 3, "frame": frame_idx})
                        last_goal_frame = frame_idx

            elif cls == 0:  # person
                cv2.rectangle(annotated, (x1, y1), (x2, y2), (255, 200, 0), 1)

        # Second pass — if ball not found and we have last position,
        # zoom into a search window and re-run detection at higher effective resolution
        if ball_cx is None and last_ball_cx is not None:
            sx1 = max(0, last_ball_cx - SEARCH_R)
            sy1 = max(0, last_ball_cy - SEARCH_R)
            sx2 = min(w, last_ball_cx + SEARCH_R)
            sy2 = min(h, last_ball_cy + SEARCH_R)
            crop_search = frame[sy1:sy2, sx1:sx2]
            # Upscale 2x so small ball appears larger to YOLO
            crop_up = cv2.resize(crop_search, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
            res2 = model(crop_up, verbose=False, classes=[32], conf=0.25)
            for box2 in res2[0].boxes:
                x1c, y1c, x2c, y2c = map(int, box2.xyxy[0])
                # Map back to full-frame coords
                ball_cx = sx1 + x1c // 2
                ball_cy = sy1 + y1c // 2
                cv2.circle(annotated, (ball_cx, ball_cy), 14, (0, 200, 255), 2)
                cv2.circle(annotated, (ball_cx, ball_cy), 4, (0, 200, 255), -1)
                break

        if ball_cx is not None:
            last_ball_cx, last_ball_cy = ball_cx, ball_cy

        # Smooth auto-zoom toward ball
        if ball_cx is not None and ball_cy is not None:
            target_w = ZOOM_W_TARGET
            target_h = int(target_w * h / w)
            zoom_x = int(zoom_x + (ball_cx - zoom_x) * ZOOM_LERP)
            zoom_y = int(zoom_y + (ball_cy - zoom_y) * ZOOM_LERP)
            zoom_w = int(zoom_w + (target_w - zoom_w) * ZOOM_LERP)
            zoom_h = int(zoom_h + (target_h - zoom_h) * ZOOM_LERP)
        else:
            # Slowly zoom back out
            zoom_w = int(zoom_w + (w - zoom_w) * 0.02)
            zoom_h = int(zoom_h + (h - zoom_h) * 0.02)

        # Clamp viewport
        half_w, half_h = zoom_w // 2, zoom_h // 2
        x1v = max(0, min(zoom_x - half_w, w - zoom_w))
        y1v = max(0, min(zoom_y - half_h, h - zoom_h))
        crop = annotated[y1v:y1v + zoom_h, x1v:x1v + zoom_w]
        out_frame = cv2.resize(crop, (w, h), interpolation=cv2.INTER_LINEAR)

        writer.write(out_frame)
        frame_idx += 1

        # Report progress every 5%
        if total_frames > 0 and frame_idx % max(1, total_frames // 20) == 0:
            pct = 20 + int((frame_idx / total_frames) * 60)  # 20-80% range
            _report(session_id, {"status": "processing", "progress": pct})

    cap.release()
    writer.release()

    # Re-mux to ensure valid mp4 with audio
    cmd = [
        "ffmpeg", "-y", "-i", str(tmp_out),
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    tmp_out.unlink(missing_ok=True)

    return goal_events


# ---------------------------------------------------------------------------
# Step 3 — Cut highlight clips
# ---------------------------------------------------------------------------

def cut_highlights(source: Path, events: list[dict], out_dir: Path) -> list[dict]:
    clips = []
    for i, ev in enumerate(events):
        clip_path = out_dir / f"highlight_{i}.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-i", str(source),
            "-ss", str(ev["start_sec"]),
            "-to", str(ev["end_sec"]),
            "-c", "copy",
            str(clip_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        clips.append({**ev, "clip_path": str(clip_path)})
    return clips


# ---------------------------------------------------------------------------
# Main Modal function
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    secrets=secrets,
    gpu="T4",          # GPU for YOLO inference
    timeout=3600,      # 1h max
    memory=8192,
)
def process_session(session_id: str) -> None:
    s3 = _r2_client()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        try:
            # -- Download raw videos
            _report(session_id, {"status": "processing", "progress": 5})
            left_path = tmp / "left.mp4"
            right_path = tmp / "right.mp4"
            _download(s3, f"sessions/{session_id}/raw/left.mp4", left_path)
            _download(s3, f"sessions/{session_id}/raw/right.mp4", right_path)
            _report(session_id, {"status": "processing", "progress": 10})

            # -- Stitch
            stitched_path = tmp / "stitched.mp4"
            sync_and_stitch(left_path, right_path, stitched_path)
            _report(session_id, {"status": "processing", "progress": 20})

            # -- Upload stitched panorama
            stitched_key = f"sessions/{session_id}/output/stitched.mp4"
            _upload(s3, stitched_path, stitched_key)

            # -- Ball/player tracking + auto-zoom
            tracked_path = tmp / "tracked.mp4"
            goal_events = run_tracking(stitched_path, tracked_path, session_id)
            _report(session_id, {"status": "processing", "progress": 80})

            # -- Upload tracked video
            tracked_key = f"sessions/{session_id}/output/tracked.mp4"
            _upload(s3, tracked_path, tracked_key)
            _report(session_id, {"status": "processing", "progress": 88})

            # -- Cut & upload highlight clips
            highlights = []
            if goal_events:
                clips_dir = tmp / "clips"
                clips_dir.mkdir()
                clips = cut_highlights(stitched_path, goal_events, clips_dir)
                for c in clips:
                    clip_key = f"sessions/{session_id}/output/{Path(c['clip_path']).name}"
                    _upload(s3, Path(c["clip_path"]), clip_key)
                    highlights.append({
                        "label": c["label"],
                        "start_sec": c["start_sec"],
                        "end_sec": c["end_sec"],
                        "clip_key": clip_key,
                    })

            _report(session_id, {"status": "processing", "progress": 95})

            # -- Done
            _report(session_id, {
                "status": "done",
                "progress": 100,
                "stitched_video_key": stitched_key,
                "tracked_video_key": tracked_key,
                "highlights": highlights,
            })

        except Exception as exc:
            _report(session_id, {
                "status": "error",
                "error_message": str(exc),
            })
            raise


# ---------------------------------------------------------------------------
# HTTP webhook endpoint (called by Vercel /api/process)
# ---------------------------------------------------------------------------

@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def process(body: dict) -> dict:
    import os
    auth = body.get("_auth", "")
    if auth != os.environ.get("MODAL_AUTH_TOKEN", ""):
        return {"error": "Unauthorized"}

    session_id = body.get("session_id")
    if not session_id:
        return {"error": "Missing session_id"}

    process_session.spawn(session_id)
    return {"jobId": f"modal-{session_id}", "ok": True}

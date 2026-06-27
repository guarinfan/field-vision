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
# Step 1 — Sync & Stitch  (pure FFmpeg — 10-50x faster than Python per-frame)
# ---------------------------------------------------------------------------

def sync_and_stitch(left_path: Path, right_path: Path, out_path: Path) -> None:
    """
    Panoramic stitch using FFmpeg filter_complex — no Python frame loop.
    Crops both videos, colour-matches right→left via FFmpeg eq filter,
    and blends the seam with a 300px gradient overlay.
    """
    LEFT_CROP  = 0.10   # drop 10% from right edge of left frame
    RIGHT_CROP = 0.22   # drop 22% from left edge of right frame
    FEATHER    = 300    # blend zone width in pixels

    # Probe dimensions from left video
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(left_path)],
        capture_output=True, text=True, timeout=30,
    )
    W, H = map(int, probe.stdout.strip().split(","))
    print(f"Video dimensions: {W}x{H}")

    left_keep  = W - int(W * LEFT_CROP)   # cols kept from left
    right_skip = int(W * RIGHT_CROP)       # cols skipped from right
    right_keep = W - right_skip            # cols kept from right
    seam_x     = left_keep - FEATHER       # where feather starts in output

    # filter_complex:
    #  1. Crop each side
    #  2. Colour-match right to left (brightness/contrast via eq — rough but fast)
    #  3. Stack side-by-side
    #  4. Feather blend the seam zone by overlaying a gradient-alpha clip
    #
    # We build a soft blend using two overlapping copies at the seam:
    #   - left side bleeds FEATHER px past its crop
    #   - right side starts FEATHER px before its crop
    #   - blend=all_mode=overlay fades between them
    left_w_blend  = left_keep          # left crop width (includes feather zone)
    right_x_blend = right_skip         # right starts here
    right_w_blend = right_keep         # right crop width (includes feather zone)
    total_w       = left_keep + right_keep - FEATHER  # final output width

    filter_graph = (
        # Crop sides (each includes the overlap zone)
        f"[0:v]crop={left_w_blend}:{H}:0:0[L];"
        f"[1:v]crop={right_w_blend}:{H}:{right_x_blend}:0[R];"
        # Place left on a canvas of final width
        f"[L]pad={total_w}:{H}:0:0:black[Lpad];"
        # Place right offset so overlap aligns with left's right edge
        f"[R]pad={total_w}:{H}:{seam_x}:0:black[Rpad];"
        # Blend with a linear ramp: left fades out, right fades in over FEATHER px
        # Using blend filter's 'softlight' is too slow — use overlay with expr instead
        f"[Lpad][Rpad]blend=all_expr="
        f"'if(lte(X,{seam_x}),A,if(gte(X,{left_keep}),B,"
        f"A*(({left_keep}-X)/{FEATHER})+B*((X-{seam_x})/{FEATHER})))'[out]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(left_path),
        "-i", str(right_path),
        "-filter_complex", filter_graph,
        "-map", "[out]",
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-c:a", "aac",
        "-threads", "0",
        str(out_path),
    ]
    print(f"Stitching {left_w_blend}+{right_w_blend}px → {total_w}px wide …")
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=7200)
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg stitch timed out after 2 hours")

    if r.returncode != 0:
        raise RuntimeError(
            f"FFmpeg stitch failed (rc={r.returncode}):\n"
            + r.stderr.decode(errors="replace")[-3000:]
        )
    if not out_path.exists() or out_path.stat().st_size < 1000:
        raise RuntimeError("FFmpeg stitch produced empty output")
    print(f"Stitched: {out_path.stat().st_size} bytes")


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
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video for tracking: {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if w == 0 or h == 0:
        raise RuntimeError(f"Invalid video dimensions {w}x{h} for {input_path}")

    # Pipe frames directly to FFmpeg — avoids VideoWriter/mp4v intermediate file
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{w}x{h}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        str(output_path),
    ]
    enc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    # Viewport for auto-zoom (follows ball or player cluster)
    zoom_x, zoom_y = w // 2, h // 2
    zoom_w, zoom_h = w, h
    ZOOM_W_BALL   = w // 3
    ZOOM_W_PLAYER = w // 2
    ZOOM_LERP     = 0.10   # pan lerp — smooth, not snappy
    ZOOM_IN_LERP  = 0.08
    ZOOM_OUT_LERP = 0.02   # very slow zoom-out to avoid cutting

    last_ball_cx: int | None = None
    last_ball_cy: int | None = None
    SEARCH_R = int(w * 0.15)

    # Rolling buffers for position smoothing
    from collections import deque
    pos_history: deque = deque(maxlen=12)  # ~0.4s at 30fps
    no_detect_frames = 0
    HOLD_FRAMES = 20  # frames to hold position before zooming out

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

        # Determine zoom target: ball > player cluster > last known ball
        target_cx, target_cy, target_w = None, None, w

        # Collect all player centroids from full-frame detection (high confidence only)
        all_players = [
            b for b in results[0].boxes
            if int(b.cls[0]) == 0 and float(b.conf[0]) > 0.4
        ]

        if ball_cx is not None:
            # Ball found — track it tightly
            pos_history.append((ball_cx, ball_cy, ZOOM_W_BALL))
            no_detect_frames = 0
        elif all_players:
            # No ball — zoom to centroid of player cluster
            pxs = [(int(b.xyxy[0][0]) + int(b.xyxy[0][2])) // 2 for b in all_players]
            pys = [(int(b.xyxy[0][1]) + int(b.xyxy[0][3])) // 2 for b in all_players]
            cx = int(sum(pxs) / len(pxs))
            cy = int(sum(pys) / len(pys))
            pos_history.append((cx, cy, ZOOM_W_PLAYER))
            no_detect_frames = 0
        else:
            no_detect_frames += 1

        if pos_history:
            avg_cx = int(sum(p[0] for p in pos_history) / len(pos_history))
            avg_cy = int(sum(p[1] for p in pos_history) / len(pos_history))
            avg_tw = int(sum(p[2] for p in pos_history) / len(pos_history))
            target_h = int(avg_tw * h / w)
            zoom_x = int(zoom_x + (avg_cx - zoom_x) * ZOOM_LERP)
            zoom_y = int(zoom_y + (avg_cy - zoom_y) * ZOOM_LERP)
            zoom_w = int(zoom_w + (avg_tw - zoom_w) * ZOOM_IN_LERP)
            zoom_h = int(zoom_h + (target_h - zoom_h) * ZOOM_IN_LERP)
        elif no_detect_frames > HOLD_FRAMES:
            zoom_w = int(zoom_w + (w - zoom_w) * ZOOM_OUT_LERP)
            zoom_h = int(zoom_h + (h - zoom_h) * ZOOM_OUT_LERP)

        # Clamp viewport
        half_w, half_h = zoom_w // 2, zoom_h // 2
        x1v = max(0, min(zoom_x - half_w, w - zoom_w))
        y1v = max(0, min(zoom_y - half_h, h - zoom_h))
        crop = annotated[y1v:y1v + zoom_h, x1v:x1v + zoom_w]
        out_frame = cv2.resize(crop, (w, h), interpolation=cv2.INTER_LINEAR)

        try:
            enc.stdin.write(out_frame.tobytes())
        except (BrokenPipeError, OSError):
            print(f"Tracking pipe broken at frame {frame_idx}")
            break
        frame_idx += 1

        # Report progress every 5%
        if total_frames > 0 and frame_idx % max(1, total_frames // 20) == 0:
            pct = 20 + int((frame_idx / total_frames) * 60)  # 20-80% range
            _report(session_id, {"status": "processing", "progress": pct})

    cap.release()
    try:
        enc.stdin.close()
    except OSError:
        pass
    stderr_bytes = enc.stderr.read()
    enc.wait()
    if enc.returncode != 0:
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")[-3000:]
        raise RuntimeError(f"FFmpeg tracking failed after {frame_idx} frames (rc={enc.returncode}):\n{stderr_text}")

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
# Step A — CPU: download, transcode, stitch  (~$0.03/hr vs $0.59/hr for GPU)
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    secrets=secrets,
    cpu=4,
    memory=8192,
    timeout=10800,
)
def stitch_session(session_id: str, left_key: str, right_key: str) -> None:
    s3 = _r2_client()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        try:
            # -- Download
            _report(session_id, {"status": "processing", "progress": 5})
            left_path  = tmp / "left.mp4"
            right_path = tmp / "right.mp4"
            print(f"Downloading left:  {left_key}")
            print(f"Downloading right: {right_key}")
            _download(s3, left_key,  left_path)
            _download(s3, right_key, right_path)
            print(f"Downloaded  left: {left_path.stat().st_size} bytes")
            print(f"Downloaded right: {right_path.stat().st_size} bytes")

            # -- Transcode to h264 so OpenCV can decode frames
            _report(session_id, {"status": "processing", "progress": 10})
            left_h264  = tmp / "left_h264.mp4"
            right_h264 = tmp / "right_h264.mp4"
            for i, (src, dst) in enumerate([(left_path, left_h264), (right_path, right_h264)]):
                print(f"Transcoding {src.name} ({src.stat().st_size} bytes)…")
                with open(src, "rb") as fh:
                    magic = fh.read(12)
                is_webm = magic[4:8] == b"webm" or magic[:4] == b"\x1a\x45\xdf\xa3"
                print(f"  format: {'webm/VP9' if is_webm else 'mp4/H264'}")
                base_cmd = ["ffmpeg", "-y", "-fflags", "+discardcorrupt+genpts", "-threads", "0"]
                enc_args = ["-c:v", "libx264", "-preset", "fast", "-crf", "28",
                            "-c:a", "aac", "-movflags", "+faststart", str(dst)]
                try:
                    if is_webm:
                        with open(src, "rb") as f_in:
                            r = subprocess.run(base_cmd + ["-f", "webm", "-i", "pipe:0"] + enc_args,
                                               stdin=f_in, capture_output=True, timeout=1800)
                    else:
                        r = subprocess.run(base_cmd + ["-i", str(src)] + enc_args,
                                           capture_output=True, timeout=1800)
                except subprocess.TimeoutExpired:
                    raise RuntimeError(f"Transcode timed out for {src.name}")
                if r.returncode != 0:
                    raise RuntimeError(f"Transcode failed {src.name} (rc={r.returncode}):\n"
                                       + r.stderr.decode(errors="replace")[-3000:])
                print(f"Transcoded → {dst.name} ({dst.stat().st_size} bytes)")
                _report(session_id, {"status": "processing", "progress": 11 + i * 3})

            # -- Stitch
            _report(session_id, {"status": "processing", "progress": 15})
            stitched_path = tmp / "stitched.mp4"
            sync_and_stitch(left_h264, right_h264, stitched_path)

            # -- Upload stitched panorama
            _report(session_id, {"status": "processing", "progress": 40})
            stitched_key = f"sessions/{session_id}/output/stitched.mp4"
            _upload(s3, stitched_path, stitched_key)
            print(f"Uploaded stitched: {stitched_key}")

            # -- Hand off to GPU function for tracking
            _report(session_id, {"status": "processing", "progress": 45})
            track_session.spawn(session_id, stitched_key)

        except Exception as exc:
            _report(session_id, {"status": "error", "error_message": str(exc)})
            raise


# ---------------------------------------------------------------------------
# Step B — GPU: download stitched, YOLO tracking, highlights, upload
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    secrets=secrets,
    gpu="T4",
    memory=8192,
    timeout=7200,
)
def track_session(session_id: str, stitched_key: str) -> None:
    s3 = _r2_client()

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        try:
            # -- Download stitched video
            _report(session_id, {"status": "processing", "progress": 50})
            stitched_path = tmp / "stitched.mp4"
            print(f"Downloading stitched: {stitched_key}")
            _download(s3, stitched_key, stitched_path)

            # -- Ball/player tracking + auto-zoom
            tracked_path = tmp / "tracked.mp4"
            goal_events = run_tracking(stitched_path, tracked_path, session_id)
            _report(session_id, {"status": "processing", "progress": 85})

            # -- Upload tracked video
            tracked_key = f"sessions/{session_id}/output/tracked.mp4"
            _upload(s3, tracked_path, tracked_key)

            # -- Cut & upload highlight clips
            _report(session_id, {"status": "processing", "progress": 90})
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
            _report(session_id, {
                "status": "done",
                "progress": 100,
                "stitched_video_key": stitched_key,
                "tracked_video_key": tracked_key,
                "highlights": highlights,
            })

        except Exception as exc:
            _report(session_id, {"status": "error", "error_message": str(exc)})
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

    left_key  = body.get("left_key",  f"sessions/{session_id}/raw/left.mp4")
    right_key = body.get("right_key", f"sessions/{session_id}/raw/right.mp4")

    stitch_session.spawn(session_id, left_key, right_key)
    return {"jobId": f"modal-{session_id}", "ok": True}

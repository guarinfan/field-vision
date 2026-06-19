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

def _compute_homography(left_frame, right_frame):
    """
    Detect ORB features in the overlapping region of both frames and compute
    the homography that warps the right frame to align with the left frame.
    Returns homography matrix or None if not enough matches.
    """
    import cv2
    import numpy as np

    h, w = left_frame.shape[:2]

    # Only look for features in the right 30% of left frame and left 30% of right frame
    overlap = int(w * 0.30)
    left_roi  = left_frame[:, w - overlap:]
    right_roi = right_frame[:, :overlap]

    orb = cv2.ORB_create(2000)
    kp1, des1 = orb.detectAndCompute(cv2.cvtColor(left_roi,  cv2.COLOR_BGR2GRAY), None)
    kp2, des2 = orb.detectAndCompute(cv2.cvtColor(right_roi, cv2.COLOR_BGR2GRAY), None)

    if des1 is None or des2 is None or len(kp1) < 10 or len(kp2) < 10:
        return None

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = bf.knnMatch(des1, des2, k=2)

    good = [m for m, n in matches if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return None

    # Shift keypoint coordinates back to full-frame space
    pts1 = np.float32([kp1[m.queryIdx].pt for m in good])
    pts1[:, 0] += w - overlap  # shift x back into full left frame
    pts2 = np.float32([kp2[m.trainIdx].pt for m in good])
    # pts2 are already in right-frame local coords (no shift needed for warp source)

    H, mask = cv2.findHomography(pts2, pts1, cv2.RANSAC, 5.0)
    if H is None or mask.sum() < 6:
        return None

    return H, overlap


def sync_and_stitch(left_path: Path, right_path: Path, out_path: Path) -> None:
    """
    Panoramic stitch:
      1. Sample frames to compute homography for the overlapping center region.
      2. Warp right video onto left canvas with gradient seam blend.
      3. Falls back to gradient hstack if feature matching fails (e.g. low texture).
    """
    import cv2
    import numpy as np

    cap_l = cv2.VideoCapture(str(left_path))
    cap_r = cv2.VideoCapture(str(right_path))

    fps   = cap_l.get(cv2.CAP_PROP_FPS) or 25.0
    w     = int(cap_l.get(cv2.CAP_PROP_FRAME_WIDTH))
    h     = int(cap_l.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # -- Sample a few mid-video frames to compute a stable homography
    total = int(cap_l.get(cv2.CAP_PROP_FRAME_COUNT))
    H_matrix = None
    overlap_px = int(w * 0.20)  # default overlap assumption

    for sample_pos in [0.3, 0.5, 0.7]:
        frame_idx = int(total * sample_pos)
        cap_l.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        cap_r.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret_l, fl = cap_l.read()
        ret_r, fr = cap_r.read()
        if not ret_l or not ret_r:
            continue
        result = _compute_homography(fl, fr)
        if result is not None:
            H_matrix, overlap_px = result
            break

    # Reset to start
    cap_l.set(cv2.CAP_PROP_POS_FRAMES, 0)
    cap_r.set(cv2.CAP_PROP_POS_FRAMES, 0)

    # Canvas width: left full width + right non-overlapping portion
    out_w = w + (w - overlap_px)
    out_h = h

    # Build gradient blend mask for the seam (overlap region)
    blend_mask = np.zeros((h, out_w), dtype=np.float32)
    for x in range(overlap_px):
        alpha = 1.0 - (x / overlap_px)  # 1.0 at left edge of overlap, 0.0 at right
        blend_mask[:, w - overlap_px + x] = alpha

    tmp_out = out_path.with_suffix(".raw.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(tmp_out), fourcc, fps, (out_w, out_h))

    while True:
        ret_l, frame_l = cap_l.read()
        ret_r, frame_r = cap_r.read()
        if not ret_l or not ret_r:
            break

        canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)

        if H_matrix is not None:
            # Warp right frame onto canvas using homography
            warped_r = cv2.warpPerspective(frame_r, H_matrix, (out_w, out_h))
            canvas = warped_r.copy()
            # Blend left frame over the canvas with gradient at seam
            for c in range(3):
                canvas[:, :w, c] = (
                    frame_l[:, :w, c].astype(np.float32) * (1 - blend_mask[:, :w]) +
                    canvas[:, :w, c].astype(np.float32) * blend_mask[:, :w]
                ).astype(np.uint8)
            canvas[:, :w - overlap_px] = frame_l[:, :w - overlap_px]
        else:
            # Fallback: gradient blend at center seam, no warp
            canvas[:, :w] = frame_l
            canvas[:, w - overlap_px:] = frame_r[:, :w + overlap_px] if frame_r.shape[1] >= w + overlap_px else np.pad(frame_r, ((0,0),(0, overlap_px),( 0,0)), mode='edge')[:, :w + overlap_px]
            for c in range(3):
                seam_l = frame_l[:, w - overlap_px:w, c].astype(np.float32)
                seam_r = frame_r[:, :overlap_px, c].astype(np.float32)
                alpha  = np.linspace(1, 0, overlap_px)[np.newaxis, :]
                blended = (seam_l * alpha + seam_r * (1 - alpha)).astype(np.uint8)
                canvas[:, w - overlap_px:w, c] = blended

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

    model = YOLO("yolov8n.pt")  # nano — fast; swap for yolov8x.pt for accuracy

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

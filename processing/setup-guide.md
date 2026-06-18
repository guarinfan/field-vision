# FieldVision — Setup Guide

## 1. Supabase

1. Create a project at supabase.com
2. Open **SQL Editor** and run `supabase/schema.sql`
3. Copy **Project URL** and **anon key** from Settings → API
4. Copy **service_role key** (keep this secret — server-only)

## 2. Cloudflare R2

1. Create a bucket named `field-vision` in Cloudflare dashboard
2. Generate an **API Token** with Object Read & Write permissions
3. Set the bucket **CORS policy** (required for browser uploads):

```json
[
  {
    "AllowedOrigins": ["https://your-vercel-domain.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Set this via Cloudflare dashboard: R2 → your-bucket → Settings → CORS.

## 3. Modal.com

```bash
pip install modal
modal setup          # authenticate
modal secret create field-vision-secrets \
  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_ACCESS_KEY_ID=your-key \
  R2_SECRET_ACCESS_KEY=your-secret \
  R2_BUCKET=field-vision \
  VERCEL_WEBHOOK_URL=https://your-app.vercel.app/api/webhook/modal \
  MODAL_AUTH_TOKEN=pick-a-random-secret-string

# Deploy the worker
modal deploy processing/worker.py
```

After deploying, Modal prints the webhook URL — copy it for `MODAL_WEBHOOK_URL` below.

## 4. Environment variables

Copy `.env.local.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=field-vision
MODAL_WEBHOOK_URL=   # the URL printed by `modal deploy`
MODAL_AUTH_TOKEN=    # same random string you used in step 3
```

## 5. Deploy to Vercel

```bash
npm install -g vercel
vercel --prod
```

Add all env vars in Vercel dashboard → Project → Settings → Environment Variables.

## Camera setup tips

- Mount phones at **mid-pitch height** (~2–3m) on the sideline
- Left camera: aimed at **left half**, right camera: **right half**
- Overlap the aim by ~10–15% at the center circle for better stitching
- Start recordings within 1–2 seconds of each other (audio sync handles small offsets)
- Use **landscape mode**, highest resolution your phone supports
- Lock **exposure and focus** before recording (tap and hold on iOS/Android)

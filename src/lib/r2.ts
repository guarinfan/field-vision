import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function getUploadUrl(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 3600 });
}

export async function getDownloadUrl(key: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 86400 });
}

export function videoKey(sessionId: string, camera: "left" | "right"): string {
  return `sessions/${sessionId}/raw/${camera}.mp4`;
}

export function outputKey(sessionId: string, filename: string): string {
  return `sessions/${sessionId}/output/${filename}`;
}

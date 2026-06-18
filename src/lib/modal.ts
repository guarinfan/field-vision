export async function triggerProcessingJob(sessionId: string): Promise<{ jobId: string }> {
  const res = await fetch(`${process.env.MODAL_WEBHOOK_URL}/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MODAL_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ session_id: sessionId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Modal trigger failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function triggerProcessingJob(sessionId: string): Promise<{ jobId: string }> {
  const res = await fetch(`${process.env.MODAL_WEBHOOK_URL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      _auth: process.env.MODAL_AUTH_TOKEN,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Modal trigger failed: ${res.status} ${text}`);
  }

  return res.json();
}

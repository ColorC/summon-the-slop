/** Browser transport for the Overlay note authority. */
export async function webNotesInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/lofa/overlay/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: command, args }),
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    result?: T;
    error?: string;
  } | null;
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(payload?.error || `overlay-shell bridge error: ${command}`);
  }
  return payload.result as T;
}

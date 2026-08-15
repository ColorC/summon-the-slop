/** Browser transport for the Overlay note authority. */

type BridgeResponse = {
  id?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class SocketUnavailableBeforeSend extends Error {}
class SocketDeliveryUncertain extends Error {}

const pending = new Map<string, PendingRequest>();
let activeSocket: WebSocket | null = null;
let openingSocket: Promise<WebSocket> | null = null;
let nextRequestId = 0;

function bridgeOptions(): { prefix: string; httpOnly: boolean } {
  if (typeof location === "undefined") return { prefix: "", httpOnly: false };
  const params = new URLSearchParams(location.search);
  const candidate = params.get("bridge_prefix") ?? "";
  const safePrefix = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(candidate)
    && !candidate.split("/").includes("..")
    ? candidate.replace(/\/$/, "")
    : "";
  return {
    prefix: safePrefix,
    httpOnly: params.get("notes_transport") === "http",
  };
}

function bridgePath(suffix: string): string {
  return `${bridgeOptions().prefix}${suffix}`;
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}

function receiveBridgeMessage(event: MessageEvent): void {
  let payload: BridgeResponse;
  try {
    payload = JSON.parse(String(event.data)) as BridgeResponse;
  } catch {
    return;
  }
  if (typeof payload.id !== "string") return;
  const request = pending.get(payload.id);
  if (!request) return;
  pending.delete(payload.id);
  clearTimeout(request.timeout);
  if (payload.ok === false) {
    request.reject(new Error(payload.error || "overlay-shell WebSocket bridge error"));
    return;
  }
  request.resolve(payload.result);
}

function websocketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${bridgePath("/lofa/overlay/invoke-ws")}`;
}

function ensureSocket(): Promise<WebSocket> {
  if (typeof WebSocket !== "function" || typeof location === "undefined") {
    return Promise.reject(new SocketUnavailableBeforeSend("WebSocket is unavailable"));
  }
  if (activeSocket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(activeSocket);
  }
  if (openingSocket) return openingSocket;

  const candidate = new WebSocket(websocketUrl());
  const opening = new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const connectionTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (openingSocket === opening) openingSocket = null;
      candidate.close();
      reject(new SocketUnavailableBeforeSend("note bridge WebSocket connection timed out"));
    }, 1500);

    candidate.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      activeSocket = candidate;
      if (openingSocket === opening) openingSocket = null;
      resolve(candidate);
    });
    candidate.addEventListener("message", receiveBridgeMessage);
    candidate.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      if (openingSocket === opening) openingSocket = null;
      candidate.close();
      reject(new SocketUnavailableBeforeSend("note bridge WebSocket connection failed"));
    });
    candidate.addEventListener("close", () => {
      if (activeSocket === candidate) activeSocket = null;
      if (!settled) {
        settled = true;
        clearTimeout(connectionTimeout);
        if (openingSocket === opening) openingSocket = null;
        reject(new SocketUnavailableBeforeSend("note bridge WebSocket closed before opening"));
      }
      rejectPending(new SocketDeliveryUncertain(
        "note bridge WebSocket closed after a request may have been delivered",
      ));
    });
  });
  openingSocket = opening;
  return opening;
}

async function invokeHttp<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(bridgePath("/lofa/overlay/invoke"), {
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

async function invokeWebSocket<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const socket = await ensureSocket();
  const id = `note-${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`;
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new SocketDeliveryUncertain(
        `note bridge request timed out after it may have been delivered: ${command}`,
      ));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeout,
    });
    try {
      socket.send(JSON.stringify({ id, cmd: command, args }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timeout);
      reject(new SocketUnavailableBeforeSend(
        error instanceof Error ? error.message : "note bridge WebSocket send failed",
      ));
    }
  });
}

export async function webNotesInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<T> {
  if (bridgeOptions().httpOnly) return invokeHttp<T>(command, args);
  try {
    return await invokeWebSocket<T>(command, args, timeoutMs);
  } catch (error) {
    // Only retry when the command was definitely not sent. Retrying an uncertain
    // write could execute it twice; those errors stay visible to the caller.
    if (error instanceof SocketUnavailableBeforeSend) {
      return invokeHttp<T>(command, args);
    }
    throw error;
  }
}

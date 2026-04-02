import * as http from 'http';

// Map of sessionId → set of SSE response objects
const subscribers = new Map<number, Set<http.ServerResponse>>();

export function handleStreamApi(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: number,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(': connected\n\n');

  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId)!.add(res);

  // Keepalive ping every 15s
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  _req.on('close', () => {
    clearInterval(ping);
    subscribers.get(sessionId)?.delete(res);
  });
}

export function broadcastEvent(event: unknown, sessionId?: number): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;

  if (sessionId !== undefined) {
    subscribers.get(sessionId)?.forEach((res) => res.write(data));
  } else {
    // Broadcast to all
    subscribers.forEach((subs) => subs.forEach((res) => res.write(data)));
  }
}

import { useState, useEffect, useRef } from 'react';

export interface StreamEvent { type: string; [key: string]: unknown; }

export function useSessionStream(sessionId: number | null) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    esRef.current = es;
    setConnected(true);

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setEvents((prev) => [...prev, data]);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => setConnected(false);

    return () => { es.close(); setConnected(false); };
  }, [sessionId]);

  return { events, connected };
}

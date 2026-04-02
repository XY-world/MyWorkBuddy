import { useState, useEffect } from 'react';

export interface SessionSummary {
  id: number;
  workItemId: number;
  title: string;
  status: string;
  phase: string;
  branch: string;
  prUrl?: string;
  taskCount: number;
  tasksDone: number;
  createdAt: number;
  updatedAt: number;
}

export function useSessions(pollMs = 3000) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  const startSession = async (workItemId: number) => {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workItemId }),
    });
    fetchSessions();
  };

  return { sessions, loading, error, refetch: fetchSessions, startSession };
}

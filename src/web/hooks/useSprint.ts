import { useState, useEffect, useRef } from 'react';

export interface SprintWorkItem {
  id: number; title: string; description: string; state: string;
  type: string; assignedTo: string; storyPoints?: number; tags: string;
  session?: { id: number; phase: string; status: string; prUrl?: string } | null;
}

export interface Iteration { id: string; name: string; path: string; isCurrent: boolean; }

export function useSprint(iterationPath?: string) {
  const [workItems, setWorkItems] = useState<SprintWorkItem[]>([]);
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [current, setCurrent] = useState<Iteration | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSprint = async (path?: string, isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const q = path ? `?iteration=${encodeURIComponent(path)}` : '';
      const res = await fetch(`/api/sprint${q}`);
      const data = await res.json();
      if (data.error) { setError(data.error); } else {
        setWorkItems(data.workItems ?? []);
        setIterations(data.iterations ?? []);
        setCurrent(data.currentIteration ?? null);
        setError(null);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const initialized = useRef(false);
  useEffect(() => {
    fetchSprint(iterationPath, initialized.current);
    initialized.current = true;
  }, [iterationPath]);
  return { workItems, iterations, current, loading, refreshing, error, fetchSprint };
}

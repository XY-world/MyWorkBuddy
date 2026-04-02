import React, { useEffect, useState } from 'react';
import {
  Spinner, Text, Button, Badge, Input, makeStyles, tokens,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Select,
} from '@fluentui/react-components';
import { ArrowLeft24Regular, ArrowDownload24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' },
  table: { width: '100%', borderCollapse: 'collapse' },
  typeCell: { width: '160px' },
  timeCell: { width: '140px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  agentCell: { width: '100px' },
  dataCell: {
    fontFamily: 'Consolas, monospace', fontSize: '11px',
    color: tokens.colorNeutralForeground3, maxWidth: '320px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  empty: { padding: '40px 0', textAlign: 'center', color: tokens.colorNeutralForeground3 },
  count: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, marginLeft: 'auto' },
});

const EVENT_TYPES = [
  'all', 'phase_start', 'phase_complete', 'task_start', 'task_complete',
  'task_failed', 'agent_message', 'code_change', 'pr_created', 'error',
];

const TYPE_COLORS: Record<string, 'brand' | 'success' | 'danger' | 'warning' | 'informative' | 'neutral'> = {
  phase_start: 'brand',
  phase_complete: 'success',
  task_start: 'informative',
  task_complete: 'success',
  task_failed: 'danger',
  agent_message: 'neutral',
  code_change: 'warning',
  pr_created: 'success',
  error: 'danger',
};

interface AuditEntry {
  id: number;
  sessionId: number;
  eventType: string;
  agent: string | null;
  phase: string | null;
  summary: string;
  data: string | null;
  createdAt: string;
}

interface Props {
  sessionId: number;
  onBack: () => void;
}

export function AuditLog({ sessionId, onBack }: Props) {
  const styles = useStyles();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/audit`)
      .then((r) => r.json())
      .then((d) => { setEntries(d); setLoading(false); });
  }, [sessionId]);

  const filtered = entries.filter((e) => {
    if (filter !== 'all' && e.eventType !== filter) return false;
    if (search && !e.summary.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-session-${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <Spinner label="Loading audit log..." />;

  return (
    <div>
      <div className={styles.header}>
        <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onBack} />
        <Text size={500} weight="semibold">Audit Log — Session #{sessionId}</Text>
      </div>

      <div className={styles.toolbar}>
        <Select value={filter} onChange={(_, d) => setFilter(d.value)} style={{ minWidth: '160px' }}>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t === 'all' ? 'All event types' : t.replace('_', ' ')}</option>
          ))}
        </Select>
        <Input
          placeholder="Search summary..."
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          style={{ minWidth: '220px' }}
        />
        <Button icon={<ArrowDownload24Regular />} onClick={exportJson} appearance="subtle">
          Export JSON
        </Button>
        <Text className={styles.count}>{filtered.length} events</Text>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          <Text>No audit events match your filter.</Text>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell className={styles.timeCell}>Time</TableHeaderCell>
              <TableHeaderCell className={styles.typeCell}>Event</TableHeaderCell>
              <TableHeaderCell className={styles.agentCell}>Agent</TableHeaderCell>
              <TableHeaderCell>Summary</TableHeaderCell>
              <TableHeaderCell>Data</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => (
              <TableRow key={e.id}>
                <TableCell className={styles.timeCell}>
                  {new Date(e.createdAt).toLocaleTimeString()}
                </TableCell>
                <TableCell className={styles.typeCell}>
                  <Badge
                    size="small"
                    appearance="tint"
                    color={TYPE_COLORS[e.eventType] ?? 'neutral'}
                  >
                    {e.eventType.replace('_', ' ')}
                  </Badge>
                </TableCell>
                <TableCell className={styles.agentCell}>
                  {e.agent && (
                    <Text style={{ fontSize: tokens.fontSizeBase200, color: tokens.colorBrandForeground1 }}>
                      {e.agent}
                    </Text>
                  )}
                </TableCell>
                <TableCell>
                  <Text style={{ fontSize: tokens.fontSizeBase200 }}>{e.summary}</Text>
                </TableCell>
                <TableCell className={styles.dataCell} title={e.data ?? ''}>
                  {e.data ? e.data.slice(0, 80) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import {
  Spinner, Text, Badge, ProgressBar, Button, makeStyles, tokens, Accordion, AccordionItem, AccordionHeader, AccordionPanel,
} from '@fluentui/react-components';
import {
  CheckmarkCircle16Filled, ErrorCircle16Filled, CircleHalfFill16Regular,
  ArrowLeft24Regular, Wifi124Regular,
} from '@fluentui/react-icons';
import { AgentBadge } from './AgentBadge';
import { useSessionStream } from '../hooks/useSessionStream';

const PHASES = ['planning', 'development', 'review', 'pr_creation', 'complete'];

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' },
  pipeline: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' },
  connector: { flex: 1, height: '2px', backgroundColor: tokens.colorNeutralStroke2, maxWidth: '80px' },
  connectorDone: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  section: { marginBottom: '20px' },
  sectionTitle: { fontWeight: 700, marginBottom: '10px', fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
  taskRow: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  taskTitle: { flex: 1 },
  logBox: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px', fontFamily: 'Consolas, monospace', fontSize: '12px',
    maxHeight: '300px', overflowY: 'auto',
    color: tokens.colorNeutralForeground2,
  },
  logLine: { marginBottom: '4px' },
  fileRow: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    fontFamily: 'Consolas, monospace', fontSize: '13px',
  },
  liveDot: { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#27ae60', display: 'inline-block', marginRight: '4px' },
});

interface Props {
  sessionId: number;
  onBack: () => void;
}

export function SessionDetail({ sessionId, onBack }: Props) {
  const styles = useStyles();
  const { events, connected } = useSessionStream(sessionId);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => { setDetail(d); setLoading(false); });
  }, [sessionId, events.length]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  if (loading) return <Spinner label="Loading session..." />;
  if (!detail) return <Text>Session not found</Text>;

  const { session, tasks, changes } = detail;
  const done = tasks.filter((t: any) => t.status === 'done').length;
  const pct = tasks.length > 0 ? done / tasks.length : 0;
  const phaseIdx = PHASES.indexOf(session.phase);

  const statusIcon = (status: string) => {
    if (status === 'done') return <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground3 }} />;
    if (status === 'failed') return <ErrorCircle16Filled style={{ color: tokens.colorPaletteRedForeground3 }} />;
    if (status === 'running') return <CircleHalfFill16Regular style={{ color: tokens.colorBrandForeground1 }} />;
    return <span style={{ width: 16, display: 'inline-block' }} />;
  };

  return (
    <div>
      {/* Header */}
      <div className={styles.header}>
        <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onBack} />
        <Text size={500} weight="semibold">WI #{session.workItemId} · {session.title || 'Loading...'}</Text>
        {connected && (
          <Badge color="success" appearance="tint" icon={<Wifi124Regular />} size="small">LIVE</Badge>
        )}
      </div>

      <Text style={{ color: tokens.colorNeutralForeground3, marginBottom: '16px', display: 'block' }}>
        Branch: {session.branch || '(none)'} · {session.phase}
      </Text>

      {/* Pipeline stages */}
      <div className={styles.pipeline}>
        {PHASES.map((phase, i) => (
          <React.Fragment key={phase}>
            {i > 0 && <div className={`${styles.connector} ${i <= phaseIdx ? styles.connectorDone : ''}`} />}
            <Badge
              appearance={i < phaseIdx ? 'filled' : i === phaseIdx ? 'tint' : 'outline'}
              color={i < phaseIdx ? 'success' : i === phaseIdx ? 'brand' : 'neutral'}
              size="small"
            >
              {phase.replace('_', ' ')}
            </Badge>
          </React.Fragment>
        ))}
      </div>

      {/* Progress */}
      <ProgressBar value={pct} style={{ marginBottom: '20px' }} />

      {/* Tasks */}
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>Tasks — {done}/{tasks.length} done</Text>
        {tasks.map((t: any) => (
          <div key={t.id} className={styles.taskRow}>
            {statusIcon(t.status)}
            <AgentBadge agent={t.agent} />
            <Text className={styles.taskTitle}>{t.title}</Text>
            {t.resultSummary && <Text style={{ color: tokens.colorNeutralForeground3, fontSize: '12px' }}>{t.resultSummary.slice(0, 60)}</Text>}
          </div>
        ))}
      </div>

      {/* Files Changed */}
      {changes.length > 0 && (
        <div className={styles.section}>
          <Text className={styles.sectionTitle}>Files Changed ({changes.length})</Text>
          {changes.map((c: any) => (
            <div key={c.id} className={styles.fileRow}>
              <span style={{ color: tokens.colorBrandForeground1 }}>📄</span>
              <Text style={{ flex: 1 }}>{c.filePath}</Text>
              <Badge size="small" appearance="outline" color={c.beforeHash ? 'neutral' : 'success'}>
                {c.beforeHash ? 'modified' : 'new'}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Live agent log */}
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>
          Agent Log {connected && <span><span className={styles.liveDot} />live</span>}
        </Text>
        <div className={styles.logBox} ref={logRef}>
          {events.length === 0
            ? <div className={styles.logLine} style={{ color: tokens.colorNeutralForeground3 }}>No events yet...</div>
            : events.map((e, i) => (
                <div key={i} className={styles.logLine}>
                  <span style={{ color: tokens.colorNeutralForeground3 }}>{new Date().toLocaleTimeString()} </span>
                  <span style={{ color: e.type === 'error' ? '#e74c3c' : e.type === 'pr_created' ? '#27ae60' : 'inherit' }}>
                    [{e.type}] {JSON.stringify(e).slice(0, 100)}
                  </span>
                </div>
              ))
          }
        </div>
      </div>

      {session.prUrl && (
        <Button as="a" href={session.prUrl} target="_blank" appearance="primary">
          Open Pull Request ↗
        </Button>
      )}
    </div>
  );
}

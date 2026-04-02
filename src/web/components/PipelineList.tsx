import React from 'react';
import { Spinner, Text, Divider, makeStyles, tokens } from '@fluentui/react-components';
import { PipelineRow } from './PipelineRow';
import { useSessions } from '../hooks/useSessions';

const useStyles = makeStyles({
  section: { marginBottom: '24px' },
  sectionTitle: { marginBottom: '12px', color: tokens.colorNeutralForeground2, fontWeight: 700, textTransform: 'uppercase', fontSize: tokens.fontSizeBase200, letterSpacing: '0.05em' },
  empty: { color: tokens.colorNeutralForeground3, padding: '20px 0' },
});

interface Props { onViewSession: (id: number) => void; }

export function PipelineList({ onViewSession }: Props) {
  const styles = useStyles();
  const { sessions, loading, error } = useSessions();

  if (loading) return <Spinner label="Loading pipelines..." />;
  if (error) return <Text style={{ color: 'red' }}>{error}</Text>;

  const active = sessions.filter((s) => s.status === 'active');
  const done = sessions.filter((s) => s.status !== 'active');

  return (
    <div>
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>Active Pipelines ({active.length})</Text>
        {active.length === 0
          ? <Text className={styles.empty}>No active pipelines. Run a work item from the Sprint Board.</Text>
          : active.map((s) => <PipelineRow key={s.id} session={s} onView={onViewSession} />)
        }
      </div>

      {done.length > 0 && (
        <>
          <Divider style={{ marginBottom: '16px' }} />
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>Completed ({done.length})</Text>
            {done.map((s) => <PipelineRow key={s.id} session={s} onView={onViewSession} />)}
          </div>
        </>
      )}
    </div>
  );
}

import React from 'react';
import { Badge, ProgressBar, Text, Button, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Filled, DismissCircle16Filled, CircleHalfFill16Regular } from '@fluentui/react-icons';
import type { SessionSummary } from '../hooks/useSessions';

const PHASES = ['planning', 'development', 'review', 'pr_creation', 'complete'];

function phaseIndex(phase: string): number {
  const idx = PHASES.indexOf(phase);
  return idx === -1 ? 0 : idx;
}

const useStyles = makeStyles({
  row: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '16px 20px',
    marginBottom: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  stages: { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '10px' },
  connector: { flex: 1, height: '2px', backgroundColor: tokens.colorNeutralStroke2, maxWidth: '60px' },
  connectorDone: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  footer: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' },
  subtitle: { flex: 1, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

interface Props {
  session: SessionSummary;
  onView: (id: number) => void;
}

export function PipelineRow({ session, onView }: Props) {
  const styles = useStyles();
  const currentIdx = phaseIndex(session.phase);
  const pct = session.taskCount > 0 ? session.tasksDone / session.taskCount : 0;

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <div>
          <Text weight="semibold">WI #{session.workItemId}</Text>
          <Text style={{ marginLeft: 8, color: tokens.colorNeutralForeground3 }}>
            {session.title || '(loading...)'}
          </Text>
        </div>
        <Badge
          appearance="tint"
          color={session.status === 'complete' ? 'success' : session.status === 'failed' ? 'danger' : 'informative'}
        >
          {session.phase}
        </Badge>
      </div>

      {/* Stage pipeline */}
      <div className={styles.stages}>
        {PHASES.map((phase, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          const failed = session.status === 'failed' && active;
          return (
            <React.Fragment key={phase}>
              {i > 0 && (
                <div className={`${styles.connector} ${done ? styles.connectorDone : ''}`} />
              )}
              <Badge
                appearance={done ? 'filled' : active ? 'tint' : 'outline'}
                color={done ? 'success' : failed ? 'danger' : active ? 'brand' : 'neutral'}
                icon={done ? <CheckmarkCircle16Filled /> : active && !failed ? <CircleHalfFill16Regular /> : undefined}
                size="small"
              >
                {phase.replace('_', ' ')}
              </Badge>
            </React.Fragment>
          );
        })}
      </div>

      <div className={styles.footer}>
        <ProgressBar value={pct} style={{ flex: 1 }} />
        <Text className={styles.subtitle}>
          {session.tasksDone}/{session.taskCount} tasks · {Math.round(pct * 100)}%
        </Text>
        <Button size="small" onClick={() => onView(session.id)}>View</Button>
      </div>
    </div>
  );
}

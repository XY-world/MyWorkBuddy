import React from 'react';
import { Card, Badge, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import {
  TaskListSquareLtr24Regular,
  Bug24Regular,
  CheckmarkSquare24Regular,
  Play24Filled,
  Eye24Regular,
} from '@fluentui/react-icons';
import type { SprintWorkItem } from '../hooks/useSprint';

const TYPE_ICON: Record<string, React.ReactNode> = {
  'User Story': <TaskListSquareLtr24Regular style={{ color: '#0078d4' }} />,
  'Bug': <Bug24Regular style={{ color: '#e74c3c' }} />,
  'Task': <CheckmarkSquare24Regular style={{ color: '#27ae60' }} />,
};

const STATE_COLORS: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'informative'> = {
  'New': 'brand',
  'Active': 'warning',
  'Resolved': 'success',
  'Closed': 'success',
  'In Review': 'informative',
};

const useStyles = makeStyles({
  card: { minWidth: '220px', maxWidth: '260px', marginBottom: '12px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
  id: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  title: { fontSize: tokens.fontSizeBase300, fontWeight: 600, marginBottom: '8px', lineHeight: 1.3 },
  meta: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' },
  sessionBadge: { fontSize: tokens.fontSizeBase100 },
  footer: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '10px' },
});

interface Props {
  workItem: SprintWorkItem;
  onRun: (id: number) => void;
  onView: (sessionId: number) => void;
}

export function WorkItemCard({ workItem, onRun, onView }: Props) {
  const styles = useStyles();
  const icon = TYPE_ICON[workItem.type] ?? <TaskListSquareLtr24Regular />;
  const stateColor = STATE_COLORS[workItem.state] ?? 'neutral';
  const session = workItem.session;

  return (
    <Card className={styles.card} size="small">
      <div className={styles.header}>
        {icon}
        <Text className={styles.id}>#{workItem.id}</Text>
        <Badge size="small" color={stateColor} appearance="tint">{workItem.state}</Badge>
      </div>
      <Text className={styles.title}>{workItem.title}</Text>
      <div className={styles.meta}>
        {workItem.storyPoints && (
          <Badge size="small" appearance="outline">{workItem.storyPoints} pts</Badge>
        )}
        {workItem.assignedTo && (
          <Text style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 }}>
            {workItem.assignedTo.split(' ')[0]}
          </Text>
        )}
      </div>

      {session && (
        <Badge className={styles.sessionBadge} color="informative" appearance="tint">
          {session.phase} {session.status === 'active' ? '↻' : ''}
        </Badge>
      )}

      <div className={styles.footer}>
        {session ? (
          <Button size="small" icon={<Eye24Regular />} onClick={() => onView(session.id)}>
            View Pipeline
          </Button>
        ) : (
          <Button size="small" appearance="primary" icon={<Play24Filled />} onClick={() => onRun(workItem.id)}>
            Run with myworkbuddy
          </Button>
        )}
      </div>
    </Card>
  );
}

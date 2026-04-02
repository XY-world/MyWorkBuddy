import React, { useState } from 'react';
import {
  Spinner, Text, Select, makeStyles, tokens, Dropdown, Option,
} from '@fluentui/react-components';
import { WorkItemCard } from './WorkItemCard';
import { useSprint } from '../hooks/useSprint';
import { useSessions } from '../hooks/useSessions';

const STATES = ['New', 'Active', 'In Review', 'Closed'];

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' },
  board: { display: 'flex', gap: '16px', overflowX: 'auto' },
  column: {
    minWidth: '270px', flex: '0 0 270px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusLarge,
    padding: '12px',
  },
  columnHeader: {
    fontWeight: 700, fontSize: tokens.fontSizeBase400,
    marginBottom: '12px', paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', justifyContent: 'space-between',
  },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, padding: '12px 0' },
});

interface Props {
  onViewSession: (sessionId: number) => void;
}

export function SprintBoard({ onViewSession }: Props) {
  const styles = useStyles();
  const [selectedIteration, setSelectedIteration] = useState<string | undefined>();
  const { workItems, iterations, current, loading, refreshing, error } = useSprint(selectedIteration);
  const { startSession } = useSessions();

  if (loading) return <Spinner label="Loading sprint..." />;
  if (error) return <Text style={{ color: 'red' }}>{error}</Text>;

  const columns = STATES.map((state) => ({
    state,
    items: workItems.filter((w) => w.state === state || (state === 'New' && !STATES.slice(1).includes(w.state))),
  }));

  return (
    <div>
      <div className={styles.toolbar}>
        <Text weight="semibold">Sprint:</Text>
        <Dropdown
          value={current?.name ?? 'Select sprint'}
          selectedOptions={selectedIteration ? [selectedIteration] : (current ? [current.path] : [])}
          onOptionSelect={(_e, data) => {
            setSelectedIteration(data.optionValue as string);
          }}
          style={{ minWidth: '220px' }}
        >
          {iterations.map((it) => (
            <Option key={it.id} value={it.path} text={it.name}>
              {it.name} {it.isCurrent ? '(current)' : ''}
            </Option>
          ))}
        </Dropdown>
        {refreshing
          ? <Spinner size="tiny" label="Loading..." labelPosition="after" />
          : <Text style={{ color: tokens.colorNeutralForeground3 }}>{workItems.length} work items</Text>
        }
      </div>

      <div className={styles.board}>
        {columns.map(({ state, items }) => (
          <div key={state} className={styles.column}>
            <div className={styles.columnHeader}>
              <span>{state}</span>
              <Text style={{ color: tokens.colorNeutralForeground3, fontWeight: 400 }}>{items.length}</Text>
            </div>
            {items.length === 0
              ? <Text className={styles.empty}>No items</Text>
              : items.map((wi) => (
                  <WorkItemCard
                    key={wi.id}
                    workItem={wi}
                    onRun={async (id) => { await startSession(id); }}
                    onView={onViewSession}
                  />
                ))
            }
          </div>
        ))}
      </div>
    </div>
  );
}

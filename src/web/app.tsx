import React, { useState } from 'react';
import { AppShell, NavPage } from './components/AppShell';
import { SprintBoard } from './components/SprintBoard';
import { PipelineList } from './components/PipelineList';
import { SessionDetail } from './components/SessionDetail';
import { AuditLog } from './components/AuditLog';
import { Text, makeStyles, tokens, Card } from '@fluentui/react-components';
import { Settings24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  settingsCard: { maxWidth: '480px' },
  settingRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  settingLabel: { fontWeight: 600 },
  settingDesc: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

type View =
  | { type: 'page'; page: NavPage }
  | { type: 'session'; id: number }
  | { type: 'audit'; id: number };

function SettingsPage() {
  const styles = useStyles();
  return (
    <Card className={styles.settingsCard}>
      <Text size={400} weight="semibold" style={{ marginBottom: '16px', display: 'block' }}>
        <Settings24Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />
        Settings
      </Text>
      {[
        { label: 'ADO Organization', desc: 'Configured via myworkbuddy config set' },
        { label: 'ADO Project', desc: 'Configured via myworkbuddy config set' },
        { label: 'AI Engine', desc: 'GitHub Copilot CLI (local)' },
        { label: 'Database', desc: '~/.myworkbuddy/myworkbuddy.db (SQLite)' },
        { label: 'Config file', desc: '~/.myworkbuddy/config.json' },
      ].map((s) => (
        <div key={s.label} className={styles.settingRow}>
          <div>
            <Text className={styles.settingLabel}>{s.label}</Text>
            <Text className={styles.settingDesc} block>{s.desc}</Text>
          </div>
        </div>
      ))}
    </Card>
  );
}

const PAGE_TITLES: Record<NavPage, string> = {
  sprint: 'Sprint Board',
  pipelines: 'Pipelines',
  history: 'History',
  settings: 'Settings',
};

export function App() {
  const [view, setView] = useState<View>({ type: 'page', page: 'sprint' });

  const activePage: NavPage = view.type === 'page' ? view.page : view.type === 'session' ? 'pipelines' : 'history';

  const handleNavigate = (page: NavPage) => setView({ type: 'page', page });
  const handleViewSession = (id: number) => setView({ type: 'session', id });
  const handleBack = () => setView({ type: 'page', page: activePage });

  const pageTitle = view.type === 'session'
    ? `Session #${view.id}`
    : view.type === 'audit'
    ? `Audit #${view.id}`
    : PAGE_TITLES[view.page];

  const renderContent = () => {
    if (view.type === 'session') {
      return (
        <SessionDetail
          sessionId={view.id}
          onBack={handleBack}
        />
      );
    }
    if (view.type === 'audit') {
      return (
        <AuditLog
          sessionId={view.id}
          onBack={handleBack}
        />
      );
    }
    switch (view.page) {
      case 'sprint':
        return <SprintBoard onViewSession={handleViewSession} />;
      case 'pipelines':
        return <PipelineList onViewSession={handleViewSession} />;
      case 'history':
        return <PipelineList onViewSession={handleViewSession} />;
      case 'settings':
        return <SettingsPage />;
    }
  };

  return (
    <AppShell activePage={activePage} pageTitle={pageTitle} onNavigate={handleNavigate}>
      {renderContent()}
    </AppShell>
  );
}

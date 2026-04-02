import React, { useState } from 'react';
import {
  FluentProvider,
  makeStyles,
  tokens,
  Button,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import {
  CalendarLtr24Regular,
  Flow24Regular,
  History24Regular,
  Settings24Regular,
  BotSparkle24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular,
} from '@fluentui/react-icons';
import { darkTheme, lightTheme } from '../theme';

const useStyles = makeStyles({
  root: { display: 'flex', height: '100vh', overflow: 'hidden' },
  sidebar: {
    width: '56px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    paddingTop: '12px', paddingBottom: '12px', gap: '4px',
  },
  logo: { marginBottom: '16px', color: tokens.colorBrandForeground1 },
  navBtn: {
    minWidth: '40px', width: '40px', height: '40px', padding: '0',
    borderRadius: tokens.borderRadiusMedium,
  },
  activeNavBtn: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  spacer: { flex: 1 },
  main: { flex: 1, overflow: 'auto', backgroundColor: tokens.colorNeutralBackground1 },
  header: {
    height: '48px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center',
    paddingLeft: '20px', paddingRight: '16px', gap: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    position: 'sticky', top: 0, zIndex: 10,
  },
  headerTitle: { flex: 1, fontWeight: 600 },
  content: { padding: '20px' },
});

export type NavPage = 'sprint' | 'pipelines' | 'history' | 'settings';

interface Props {
  activePage: NavPage;
  pageTitle: string;
  onNavigate: (page: NavPage) => void;
  children: React.ReactNode;
}

export function AppShell({ activePage, pageTitle, onNavigate, children }: Props) {
  const styles = useStyles();
  const [darkMode, setDarkMode] = useState(true);

  const navItems: Array<{ page: NavPage; icon: React.ReactNode; label: string }> = [
    { page: 'sprint', icon: <CalendarLtr24Regular />, label: 'Sprint Board' },
    { page: 'pipelines', icon: <Flow24Regular />, label: 'Pipelines' },
    { page: 'history', icon: <History24Regular />, label: 'History' },
    { page: 'settings', icon: <Settings24Regular />, label: 'Settings' },
  ];

  return (
    <FluentProvider theme={darkMode ? darkTheme : lightTheme}>
      <div className={styles.root}>
        {/* Sidebar */}
        <div className={styles.sidebar}>
          <Tooltip content="myworkbuddy" relationship="label" positioning="after">
            <div className={styles.logo}><BotSparkle24Regular /></div>
          </Tooltip>
          {navItems.map((item) => (
            <Tooltip key={item.page} content={item.label} relationship="label" positioning="after">
              <Button
                className={`${styles.navBtn} ${activePage === item.page ? styles.activeNavBtn : ''}`}
                appearance="subtle"
                icon={item.icon}
                onClick={() => onNavigate(item.page)}
              />
            </Tooltip>
          ))}
          <div className={styles.spacer} />
          <Tooltip content={darkMode ? 'Light mode' : 'Dark mode'} relationship="label" positioning="after">
            <Button
              className={styles.navBtn}
              appearance="subtle"
              icon={darkMode ? <WeatherSunny24Regular /> : <WeatherMoon24Regular />}
              onClick={() => setDarkMode(!darkMode)}
            />
          </Tooltip>
        </div>

        {/* Main */}
        <div className={styles.main}>
          <div className={styles.header}>
            <BotSparkle24Regular style={{ color: tokens.colorBrandForeground1 }} />
            <Text className={styles.headerTitle}>myworkbuddy · {pageTitle}</Text>
          </div>
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </FluentProvider>
  );
}

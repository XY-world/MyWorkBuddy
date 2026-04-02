import React from 'react';
import { Badge } from '@fluentui/react-components';

const AGENT_COLORS: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'informative'> = {
  pm: 'brand',
  dev: 'success',
  review: 'warning',
  orchestrator: 'informative',
};

const AGENT_NAMES: Record<string, string> = {
  pm: 'PM · Alex',
  dev: 'Dev · Morgan',
  review: 'Review · Jordan',
  orchestrator: 'Orchestrator',
};

export function AgentBadge({ agent }: { agent: string }) {
  const key = agent.toLowerCase().split(' ')[0];
  return (
    <Badge color={AGENT_COLORS[key] ?? 'informative'} appearance="filled" size="small">
      {AGENT_NAMES[key] ?? agent}
    </Badge>
  );
}

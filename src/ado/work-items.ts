import { getAdoConnection } from './client';
import { WorkItemExpand } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { getConfig } from '../config/manager';

export interface AdoWorkItem {
  id: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  state: string;
  type: string;
  assignedTo: string;
  areaPath: string;
  iterationPath: string;
  storyPoints?: number;
  tags: string;
  url: string;
}

export async function getWorkItem(project: string, id: number): Promise<AdoWorkItem> {
  const conn = await getAdoConnection();
  const witApi = await conn.getWorkItemTrackingApi();
  const wi = await witApi.getWorkItem(id, undefined, undefined, WorkItemExpand.All);

  if (!wi || !wi.fields) throw new Error(`Work item ${id} not found`);

  const f = wi.fields;
  return {
    id,
    title: f['System.Title'] ?? '',
    description: f['System.Description'] ?? '',
    acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
    state: f['System.State'] ?? '',
    type: f['System.WorkItemType'] ?? '',
    assignedTo: f['System.AssignedTo']?.displayName ?? '',
    areaPath: f['System.AreaPath'] ?? '',
    iterationPath: f['System.IterationPath'] ?? '',
    storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'],
    tags: f['System.Tags'] ?? '',
    url: wi.url ?? '',
  };
}

export async function getWorkItemsForIteration(project: string, iterationPath: string): Promise<AdoWorkItem[]> {
  const conn = await getAdoConnection();
  const witApi = await conn.getWorkItemTrackingApi();

  const wiql = {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.IterationPath] = '${iterationPath}' ORDER BY [System.Id]`,
  };

  const result = await witApi.queryByWiql(wiql, { project });
  if (!result.workItems || result.workItems.length === 0) return [];

  const ids = result.workItems.map((w) => w.id!).filter(Boolean);
  const items = await witApi.getWorkItemsBatch({ ids, fields: [
    'System.Id', 'System.Title', 'System.Description', 'System.State',
    'System.WorkItemType', 'System.AssignedTo', 'System.IterationPath',
    'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.Scheduling.StoryPoints',
    'System.Tags',
  ]});

  return (items ?? []).map((wi) => {
    const f = wi.fields ?? {};
    return {
      id: wi.id!,
      title: f['System.Title'] ?? '',
      description: f['System.Description'] ?? '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
      state: f['System.State'] ?? '',
      type: f['System.WorkItemType'] ?? '',
      assignedTo: f['System.AssignedTo']?.displayName ?? '',
      areaPath: '',
      iterationPath: f['System.IterationPath'] ?? '',
      storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'],
      tags: f['System.Tags'] ?? '',
      url: wi.url ?? '',
    };
  });
}

export async function updateWorkItemState(project: string, id: number, state: string): Promise<void> {
  const conn = await getAdoConnection();
  const witApi = await conn.getWorkItemTrackingApi();
  await witApi.updateWorkItem(
    {},
    [{ op: 'add', path: '/fields/System.State', value: state }],
    id,
    project,
  );
}

export async function addWorkItemComment(project: string, id: number, comment: string): Promise<void> {
  const conn = await getAdoConnection();
  const witApi = await conn.getWorkItemTrackingApi();
  await witApi.addComment({ text: comment }, project, id);
}

export async function getMyWorkItemsForIteration(project: string, iterationPath: string): Promise<AdoWorkItem[]> {
  const conn = await getAdoConnection();
  const witApi = await conn.getWorkItemTrackingApi();

  const wiql = {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.IterationPath] = '${iterationPath}' AND [System.AssignedTo] = @Me ORDER BY [System.Id]`,
  };

  const result = await witApi.queryByWiql(wiql, { project });
  if (!result.workItems || result.workItems.length === 0) return [];

  const ids = result.workItems.map((w) => w.id!).filter(Boolean);
  const items = await witApi.getWorkItemsBatch({ ids, fields: [
    'System.Id', 'System.Title', 'System.Description', 'System.State',
    'System.WorkItemType', 'System.AssignedTo', 'System.IterationPath',
    'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.Scheduling.StoryPoints',
    'System.Tags',
  ]});

  return (items ?? []).map((wi) => {
    const f = wi.fields ?? {};
    return {
      id: wi.id!,
      title: f['System.Title'] ?? '',
      description: f['System.Description'] ?? '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
      state: f['System.State'] ?? '',
      type: f['System.WorkItemType'] ?? '',
      assignedTo: f['System.AssignedTo']?.displayName ?? '',
      areaPath: '',
      iterationPath: f['System.IterationPath'] ?? '',
      storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'],
      tags: f['System.Tags'] ?? '',
      url: wi.url ?? '',
    };
  });
}

export async function getTeams(project: string): Promise<Array<{ id: string; name: string }>> {
  const conn = await getAdoConnection();
  const coreApi = await conn.getCoreApi();
  const teams = await coreApi.getTeams(project);
  return (teams ?? []).map((t: any) => ({ id: t.id ?? '', name: t.name ?? '' }));
}

export async function getIterations(project: string): Promise<Array<{ id: string; name: string; path: string; isCurrent: boolean }>> {
  const conn = await getAdoConnection();
  // WorkApi exposes iteration/capacity endpoints; WorkItemTrackingApi does not.
  const workApi = await conn.getWorkApi();
  const team = getConfig().get('ado').team || `${project} Team`;
  const iterations = await workApi.getTeamIterations({ project, team, projectId: project });
  const now = Date.now();
  return (iterations ?? []).map((it: any) => {
    const start = it.attributes?.startDate ? new Date(it.attributes.startDate).getTime() : 0;
    const finish = it.attributes?.finishDate ? new Date(it.attributes.finishDate).getTime() : Infinity;
    return {
      id: it.id ?? '',
      name: it.name ?? '',
      path: it.path ?? '',
      isCurrent: now >= start && now <= finish,
    };
  });
}

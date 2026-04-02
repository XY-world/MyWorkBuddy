import * as azdev from 'azure-devops-node-api';
import { DefaultAzureCredential } from '@azure/identity';
import { getConfig } from '../config/manager';

// Azure DevOps resource ID for token scopes
const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

let _connection: azdev.WebApi | null = null;
let _tokenExpiry = 0;

export async function getAdoConnection(orgUrlOverride?: string): Promise<azdev.WebApi> {
  const config = getConfig();
  const orgUrl = orgUrlOverride ?? config.get('ado').orgUrl;
  if (!orgUrl) throw new Error('ADO org URL not configured. Run: myworkbuddy init');

  const now = Date.now();
  if (_connection && now < _tokenExpiry) return _connection;

  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken(ADO_SCOPE);
  const authHandler = azdev.getBearerHandler(tokenResponse.token);
  _connection = new azdev.WebApi(orgUrl, authHandler);
  // Refresh 5 minutes before expiry
  _tokenExpiry = tokenResponse.expiresOnTimestamp - 5 * 60 * 1000;
  return _connection;
}

export function resetAdoConnection(): void {
  _connection = null;
  _tokenExpiry = 0;
}

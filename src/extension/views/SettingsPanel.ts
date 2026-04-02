import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getSettings } from '../../config/settings-manager';
import { AgentSkillSettings, AgentSettings, Skill, McpServerConfig } from '../../config/settings-types';
import { TOOL_CATALOG, DEFAULT_AGENT_TOOLS } from '../../tools/registry';
import { getCopilotMcpTools } from '../../tools/copilot-client';

// Default soul strings for display (so user knows what they're overriding)
const DEFAULT_SOULS: Record<string, string> = {
  wi_review:     'Riley — Work Item Review Agent. Reviews feasibility and risks before any code is written.',
  pm:            'Alex — PM / Planning Agent. Breaks work items into concrete, sequential dev tasks.',
  dev:           'Morgan — Developer Agent. Implements tasks by reading and writing files in the repository.',
  review:        'Jordan — Code Review Agent. Reviews code quality, correctness, and alignment with requirements.',
  pr_fix:        'Morgan — PR Fix Agent. Addresses reviewer comments by modifying code and replying to threads.',
  investigation: 'Alex — Investigation Agent. Researches questions using available tools and synthesises findings.',
};

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  wi_review: 'Riley — WI Reviewer',
  pm: 'Alex — Planner',
  dev: 'Morgan — Developer',
  review: 'Jordan — Code Reviewer',
  pr_fix: 'Morgan — PR Fixer',
  investigation: 'Alex — Investigator',
};

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static createOrShow(context: vscode.ExtensionContext): void {
    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    SettingsPanel.instance = new SettingsPanel(context);
  }

  private constructor(_context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'myworkbuddy.settings',
      'MyWorkBuddy — Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'saveAgent':
          getSettings().setAgentSettings(msg.data as AgentSettings);
          vscode.window.showInformationMessage('Agent settings saved.');
          break;
        case 'upsertSkill':
          getSettings().upsertSkill(msg.data as Skill);
          this.pushState();
          break;
        case 'deleteSkill':
          getSettings().deleteSkill(msg.id as string);
          this.pushState();
          break;
        case 'upsertMcp':
          getSettings().upsertMcp(msg.data as McpServerConfig);
          this.pushState();
          break;
        case 'deleteMcp':
          getSettings().deleteMcp(msg.id as string);
          this.pushState();
          break;
        case 'newId':
          // Webview requests a new UUID for a skill/mcp being created
          this.panel.webview.postMessage({ type: 'newId', id: crypto.randomUUID() });
          break;
      }
    });

    this.panel.onDidDispose(() => {
      SettingsPanel.instance = undefined;
    });

    this.panel.webview.html = this.buildHtml(this.getStatePayload());
  }

  private getStatePayload() {
    const data = getSettings().getAll();
    const copilotMcpTools = getCopilotMcpTools().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    return { data, toolCatalog: TOOL_CATALOG, defaultAgentTools: DEFAULT_AGENT_TOOLS, defaultSouls: DEFAULT_SOULS, agentDisplayNames: AGENT_DISPLAY_NAMES, copilotMcpTools };
  }

  private pushState(): void {
    this.panel.webview.postMessage({ type: 'state', ...this.getStatePayload() });
  }

  private buildHtml(initialState: ReturnType<SettingsPanel['getStatePayload']>): string {
    const initJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column}

/* Tabs */
.tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;padding:0 16px}
.tab{padding:9px 16px;cursor:pointer;font-size:.88em;border-bottom:2px solid transparent;opacity:.6}
.tab.active{border-bottom-color:var(--vscode-focusBorder,#007fd4);opacity:1;font-weight:600}
.tab:hover{opacity:.9}

/* Content */
.content{flex:1;overflow:hidden;display:flex}
.pane{display:none;width:100%;height:100%;overflow:hidden}
.pane.active{display:flex}

/* Agents tab: list + detail */
.agent-list{width:200px;border-right:1px solid var(--vscode-panel-border);overflow-y:auto;flex-shrink:0}
.agent-item{padding:9px 14px;cursor:pointer;font-size:.88em;border-left:2px solid transparent}
.agent-item:hover{background:var(--vscode-list-hoverBackground)}
.agent-item.active{border-left-color:var(--vscode-focusBorder,#007fd4);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.agent-detail{flex:1;overflow-y:auto;padding:20px}

/* Skills/MCPs tab */
.tab-scroll{flex:1;overflow-y:auto;padding:20px}

/* Form elements */
label{display:block;font-size:.8em;opacity:.7;margin-bottom:4px;margin-top:14px}
label:first-child{margin-top:0}
input[type=text],textarea,select{width:100%;padding:6px 9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:.85em;font-family:var(--vscode-font-family);outline:none}
input[type=text]:focus,textarea:focus{border-color:var(--vscode-focusBorder,#007fd4)}
textarea{resize:vertical;min-height:80px;line-height:1.45}
.hint{font-size:.76em;opacity:.45;margin-top:3px}

/* Checkboxes */
.check-group{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.check-item{display:flex;align-items:center;gap:5px;font-size:.82em;padding:3px 8px;background:var(--vscode-editor-selectionBackground);border-radius:3px;cursor:pointer}
.check-item input{cursor:pointer}
.cat-label{font-size:.72em;font-weight:700;opacity:.45;text-transform:uppercase;letter-spacing:.06em;width:100%;margin-top:8px;margin-bottom:2px}

/* Buttons */
button{padding:5px 12px;border:none;border-radius:3px;cursor:pointer;font-size:.83em;font-family:var(--vscode-font-family)}
button:hover{opacity:.85}
.b-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.b-2nd{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.b-danger{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-inputValidation-errorForeground,#f88)}
.btn-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center}

/* Cards (skills, mcps) */
.card{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:12px 14px;margin-bottom:10px}
.card-title{font-weight:600;font-size:.9em;margin-bottom:4px}
.card-desc{font-size:.82em;opacity:.65;margin-bottom:8px}
.card-tags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.tag{font-size:.74em;padding:1px 7px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:9px}
.card-actions{display:flex;gap:7px}
.card.editing{background:var(--vscode-editor-selectionBackground)}

/* MCP tool list */
.mcp-tools{margin-top:8px;padding:8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:3px}
.mcp-tool-item{font-size:.78em;opacity:.75;padding:2px 0}

/* Section header */
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.section-title{font-size:1em;font-weight:700}

/* Toggle */
.toggle-row{display:flex;align-items:center;gap:8px;margin-top:6px}
input[type=checkbox].toggle{width:auto}
</style>
</head>
<body>
<div class="tabs">
  <div class="tab active" onclick="showTab('agents')">Agents</div>
  <div class="tab" onclick="showTab('skills')">Skills</div>
  <div class="tab" onclick="showTab('mcps')">MCPs</div>
</div>
<div class="content">

  <!-- AGENTS -->
  <div class="pane active" id="pane-agents">
    <div class="agent-list" id="agentList">
      ${Object.entries(AGENT_DISPLAY_NAMES).map(([k, label]) =>
        `<div class="agent-item" id="agentBtn_${k}" onclick="selectAgent('${k}')">${label}</div>`
      ).join('')}
    </div>
    <div class="agent-detail" id="agentDetail"><p style="opacity:.4;padding:20px">Select an agent to edit</p></div>
  </div>

  <!-- SKILLS -->
  <div class="pane" id="pane-skills">
    <div class="tab-scroll">
      <div class="section-header">
        <div class="section-title">Skills</div>
        <button class="b-ok" onclick="newSkill()">+ Add Skill</button>
      </div>
      <p style="font-size:.82em;opacity:.55;margin-bottom:16px">Skills are reusable prompt snippets attached to agents — they appear as "Team Standards & Practices" in the agent's system prompt.</p>
      <div id="skillsList"></div>
    </div>
  </div>

  <!-- MCPs -->
  <div class="pane" id="pane-mcps">
    <div class="tab-scroll">
      <div class="section-header">
        <div class="section-title">MCP Servers</div>
        <button class="b-ok" onclick="newMcp()">+ Add MCP</button>
      </div>
      <p style="font-size:.82em;opacity:.55;margin-bottom:16px">Configure MCP (Model Context Protocol) servers. The built-in GitHub Copilot entry exposes all MCP tools registered in your VSCode Copilot settings — no extra config needed.</p>
      <div id="mcpsList"></div>
    </div>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();

// All mutable state declared here first (avoids let TDZ errors on early renderAll())
let _state = ${initJson};
let _selectedAgent = null;
let _editingSkillId = null;
let _pendingIdResolve = null;
let _editingMcpId = null;

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'state') { _state = msg; renderAll(); }
  if (msg.type === 'newId') { _pendingIdResolve?.(msg.id); _pendingIdResolve = null; }
});

renderAll();

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function showTab(name){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active', ['agents','skills','mcps'][i]===name));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  document.getElementById('pane-'+name).classList.add('active');
}

function renderAll(){
  renderAgentList();
  renderSkills();
  renderMcps();
}

function renderAgentList(){
  // Agent items are pre-rendered in HTML; just update the active highlight
  document.querySelectorAll('.agent-item').forEach(el => {
    const key = el.id.replace('agentBtn_', '');
    el.classList.toggle('active', key === _selectedAgent);
  });
}

function selectAgent(key){
  _selectedAgent = key;
  document.querySelectorAll('.agent-item').forEach(el =>
    el.classList.toggle('active', el.id === 'agentBtn_' + key)
  );
  renderAgentDetail(key);
}

function renderAgentDetail(key){
  if(!_state) return;
  const agentData = _state.data.agents.find(a=>a.agentKey===key) || { agentKey:key, soulOverride:'', personaOverride:'', userPerspectiveOverride:'', toolOverrides:[], attachedSkillIds:[] };
  const defaultSoul = _state.defaultSouls[key] || '';
  const defaultTools = _state.defaultAgentTools[key] || [];

  // Group tools by category
  const byCategory = {};
  for(const t of _state.toolCatalog){
    if(!byCategory[t.category]) byCategory[t.category]=[];
    byCategory[t.category].push(t);
  }
  const toolHtml = Object.entries(byCategory).map(([cat,tools])=>
    \`<div class="cat-label">\${esc(cat)}</div>\`+
    tools.map(t=>{
      const checked = agentData.toolOverrides.length>0 ? agentData.toolOverrides.includes(t.name) : defaultTools.includes(t.name);
      return \`<label class="check-item"><input type="checkbox" value="\${esc(t.name)}" \${checked?'checked':''} onchange="toolChanged('\${key}',this)"><span title="\${esc(t.description)}">\${esc(t.displayName)}</span></label>\`;
    }).join('')
  ).join('');

  const skills = _state.data.skills;
  const skillHtml = skills.length===0 ? '<span style="opacity:.4;font-size:.82em">No skills yet — add some in the Skills tab</span>'
    : skills.map(s=>{
        const attached = agentData.attachedSkillIds.includes(s.id);
        return \`<label class="check-item"><input type="checkbox" value="\${esc(s.id)}" \${attached?'checked':''} onchange="skillAttachChanged('\${key}',this)"><span title="\${esc(s.promptText)}">\${esc(s.name)}</span></label>\`;
      }).join('');

  document.getElementById('agentDetail').innerHTML = \`
<h3 style="margin-bottom:16px">\${esc(_state.agentDisplayNames[key])}</h3>

<label>Persona Name <span style="opacity:.4">(leave blank for default)</span></label>
<input type="text" id="a_persona" value="\${esc(agentData.personaOverride)}" placeholder="e.g. Riley">

<label>Soul / System Prompt <span style="opacity:.4">(override)</span></label>
<textarea id="a_soul" rows="6" placeholder="\${esc(defaultSoul)}">\${esc(agentData.soulOverride)}</textarea>
<div class="hint">Leave blank to use the built-in soul. The placeholder shows the current default.</div>

<label>Stakeholder Perspective <span style="opacity:.4">(override)</span></label>
<textarea id="a_perspective" rows="3" placeholder="Leave blank to use default">\${esc(agentData.userPerspectiveOverride)}</textarea>

<label>Tools</label>
<div class="check-group" id="toolGroup_\${key}">\${toolHtml}</div>
<div class="hint">Checked = enabled. Unchecked = not available to this agent. Defaults shown when no override is set.</div>

<label>Attached Skills</label>
<div class="check-group">\${skillHtml}</div>

<div class="btn-row">
  <button class="b-ok" onclick="saveAgent('\${key}')">Save</button>
  <button class="b-2nd" onclick="resetAgent('\${key}')">Reset to Defaults</button>
</div>\`;
}

function toolChanged(key, cb){ /* handled on save */ }
function skillAttachChanged(key, cb){ /* handled on save */ }

function saveAgent(key){
  const soul = document.getElementById('a_soul')?.value?.trim()||'';
  const persona = document.getElementById('a_persona')?.value?.trim()||'';
  const perspective = document.getElementById('a_perspective')?.value?.trim()||'';
  const toolOverrides = Array.from(document.querySelectorAll(\`#toolGroup_\${key} input[type=checkbox]\`))
    .filter(c=>c.checked).map(c=>c.value);
  const attachedSkillIds = Array.from(document.querySelectorAll('.check-group input[type=checkbox][value]'))
    .filter(c=>_state.data.skills.find(s=>s.id===c.value) && c.checked).map(c=>c.value);
  vscode.postMessage({ command:'saveAgent', data:{ agentKey:key, soulOverride:soul, personaOverride:persona, userPerspectiveOverride:perspective, toolOverrides, attachedSkillIds } });
}

function resetAgent(key){
  vscode.postMessage({ command:'saveAgent', data:{ agentKey:key, soulOverride:'', personaOverride:'', userPerspectiveOverride:'', toolOverrides:[], attachedSkillIds:[] } });
  vscode.postMessage({ command:'load' });
}

// ── Skills ──────────────────────────────────────────────────────────────────

function renderSkills(){
  if(!_state) return;
  const skills = _state.data.skills;
  const list = document.getElementById('skillsList');
  if(!list) return;
  if(skills.length===0 && _editingSkillId!=='__new__'){
    list.innerHTML='<p style="opacity:.4;font-size:.85em">No skills yet. Click "+ Add Skill" to create one.</p>';
    return;
  }
  list.innerHTML = skills.map(s=>{
    if(_editingSkillId===s.id) return renderSkillForm(s);
    return \`<div class="card">
  <div class="card-title">\${esc(s.name)}</div>
  <div class="card-desc">\${esc(s.description)}</div>
  <div class="card-tags">\${s.tags.map(t=>\`<span class="tag">\${esc(t)}</span>\`).join('')}</div>
  <div style="font-size:.78em;opacity:.6;margin-bottom:8px;white-space:pre-wrap">\${esc(s.promptText.slice(0,120))}\${s.promptText.length>120?'…':''}</div>
  <div class="card-actions">
    <button class="b-2nd" onclick="editSkill('\${esc(s.id)}')">Edit</button>
    <button class="b-danger" onclick="deleteSkill('\${esc(s.id)}')">Delete</button>
  </div>
</div>\`;
  }).join('') + (_editingSkillId==='__new__' ? renderSkillForm(null) : '');
}

function renderSkillForm(s){
  const id=s?esc(s.id):'__new__';
  return \`<div class="card editing">
  <label>Name</label><input type="text" id="sk_name_\${id}" value="\${s?esc(s.name):''}">
  <label>Description</label><input type="text" id="sk_desc_\${id}" value="\${s?esc(s.description):''}">
  <label>Prompt Text (injected into agent system prompt)</label>
  <textarea id="sk_prompt_\${id}" rows="4">\${s?esc(s.promptText):''}</textarea>
  <label>Tags (comma-separated)</label><input type="text" id="sk_tags_\${id}" value="\${s?esc(s.tags.join(', ')):''}">
  <div class="btn-row">
    <button class="b-ok" onclick="saveSkill('\${id}')">Save</button>
    <button class="b-2nd" onclick="cancelSkill()">Cancel</button>
  </div>
</div>\`;
}

function newSkill(){ _editingSkillId='__new__'; renderSkills(); }
function editSkill(id){ _editingSkillId=id; renderSkills(); }
function cancelSkill(){ _editingSkillId=null; renderSkills(); }
function deleteSkill(id){ if(confirm('Delete this skill?')){ vscode.postMessage({command:'deleteSkill',id}); } }

function getNewId(){ return new Promise(r=>{ _pendingIdResolve=r; vscode.postMessage({command:'newId'}); }); }

async function saveSkill(editId){
  const id = editId==='__new__' ? await getNewId() : editId;
  const name = document.getElementById(\`sk_name_\${editId}\`)?.value?.trim()||'';
  const desc = document.getElementById(\`sk_desc_\${editId}\`)?.value?.trim()||'';
  const prompt = document.getElementById(\`sk_prompt_\${editId}\`)?.value?.trim()||'';
  const tags = document.getElementById(\`sk_tags_\${editId}\`)?.value?.split(',').map(t=>t.trim()).filter(Boolean)||[];
  if(!name||!prompt){ alert('Name and Prompt Text are required'); return; }
  _editingSkillId=null;
  vscode.postMessage({command:'upsertSkill',data:{id,name,description:desc,promptText:prompt,tags}});
}

// ── MCPs ────────────────────────────────────────────────────────────────────

function renderMcps(){
  if(!_state) return;
  const mcps = _state.data.mcps;
  const el = document.getElementById('mcpsList');
  if(!el) return;
  el.innerHTML = mcps.map(m=>{
    if(_editingMcpId===m.id) return renderMcpForm(m);
    const isBuiltin = m.type==='builtin-copilot';
    const tools = isBuiltin ? _state.copilotMcpTools : [];
    const toolBlock = isBuiltin && tools.length>0
      ? \`<div class="mcp-tools"><div style="font-size:.76em;font-weight:700;opacity:.55;margin-bottom:4px">Exposed tools (\${tools.length})</div>\${tools.map(t=>\`<div class="mcp-tool-item">• \${esc(t.name.replace('mcp_',''))} — \${esc(t.description.replace('[Copilot MCP] ',''))}</div>\`).join('')}</div>\`
      : (isBuiltin && tools.length===0 ? '<div style="font-size:.78em;opacity:.45;margin-top:6px">No MCP tools registered in Copilot yet. Configure them in VSCode settings → Extensions → GitHub Copilot → MCP.</div>' : '');
    return \`<div class="card">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <div class="card-title" style="flex:1">\${esc(m.name)}</div>
    <label class="toggle-row" style="margin:0"><input type="checkbox" class="toggle" \${m.enabled?'checked':''} onchange="toggleMcp('\${esc(m.id)}',this.checked)"> Enabled</label>
  </div>
  \${!isBuiltin?'<div class="card-desc">'+esc(m.command)+' '+esc(m.args.join(' '))+'</div>':'<div class="card-desc" style="opacity:.45">Built-in — uses vscode.lm.tools from GitHub Copilot</div>'}
  \${toolBlock}
  <div class="card-actions" style="margin-top:8px">
    \${!isBuiltin?'<button class="b-2nd" onclick="editMcp(\''+esc(m.id)+'\')">Edit</button>':''}
    \${!isBuiltin?'<button class="b-danger" onclick="deleteMcp(\''+esc(m.id)+'\')">Delete</button>':''}
  </div>
</div>\`;
  }).join('') + (_editingMcpId==='__new__' ? renderMcpForm(null) : '');
}

function renderMcpForm(m){
  const id=m?esc(m.id):'__new__';
  const envStr = m ? Object.entries(m.env||{}).map(([k,v])=>k+'='+v).join('\\n') : '';
  return \`<div class="card editing">
  <label>Name</label><input type="text" id="mc_name_\${id}" value="\${m?esc(m.name):''}">
  <label>Command</label><input type="text" id="mc_cmd_\${id}" value="\${m?esc(m.command):''}" placeholder="node">
  <label>Args (one per line)</label><textarea id="mc_args_\${id}" rows="3">\${m?esc(m.args.join('\\n')):''}</textarea>
  <label>Environment Variables (KEY=VALUE, one per line)</label><textarea id="mc_env_\${id}" rows="3">\${esc(envStr)}</textarea>
  <div class="toggle-row"><input type="checkbox" class="toggle" id="mc_en_\${id}" \${(!m||m.enabled)?'checked':''}><label for="mc_en_\${id}" style="margin:0">Enabled</label></div>
  <div class="btn-row">
    <button class="b-ok" onclick="saveMcp('\${id}')">Save</button>
    <button class="b-2nd" onclick="cancelMcp()">Cancel</button>
  </div>
</div>\`;
}

function newMcp(){ _editingMcpId='__new__'; renderMcps(); }
function editMcp(id){ _editingMcpId=id; renderMcps(); }
function cancelMcp(){ _editingMcpId=null; renderMcps(); }
function deleteMcp(id){ if(confirm('Delete this MCP?')){ vscode.postMessage({command:'deleteMcp',id}); } }
function toggleMcp(id, enabled){
  const m = _state.data.mcps.find(x=>x.id===id);
  if(m){ vscode.postMessage({command:'upsertMcp', data:{...m, enabled}}); }
}

async function saveMcp(editId){
  const id = editId==='__new__' ? await getNewId() : editId;
  const name = document.getElementById(\`mc_name_\${editId}\`)?.value?.trim()||'';
  const cmd  = document.getElementById(\`mc_cmd_\${editId}\`)?.value?.trim()||'';
  const args = document.getElementById(\`mc_args_\${editId}\`)?.value?.split('\\n').map(s=>s.trim()).filter(Boolean)||[];
  const envLines = document.getElementById(\`mc_env_\${editId}\`)?.value?.split('\\n')||[];
  const env = {};
  for(const line of envLines){ const [k,...v]=line.split('='); if(k?.trim()) env[k.trim()]=v.join('=').trim(); }
  const enabled = document.getElementById(\`mc_en_\${editId}\`)?.checked??true;
  if(!name||!cmd){ alert('Name and Command are required'); return; }
  _editingMcpId=null;
  vscode.postMessage({command:'upsertMcp', data:{id,name,type:'process',command:cmd,args,env,enabled}});
}
</script>
</body>
</html>`;
  }
}

declare function acquireVsCodeApi(): {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };

// DOM Elements
const chatLog = document.getElementById('chat-log') as HTMLElement;
const welcomeState = document.getElementById('welcome-state') as HTMLElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const refreshModelsBtn = document.getElementById('refresh-models-btn') as HTMLButtonElement;
const resetSessionBtn = document.getElementById('reset-session-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;
const budgetValue = document.getElementById('budget-value') as HTMLElement;
const budgetFill = document.getElementById('budget-progress-fill') as HTMLElement;
const sessionLabel = document.getElementById('session-label') as HTMLElement;
const chipFile = document.getElementById('chip-file') as HTMLElement;
const chipSymbol = document.getElementById('chip-symbol') as HTMLElement;
const attachChips = document.getElementById('attach-chips') as HTMLElement;
const mcpToolsBtn = document.getElementById('mcp-tools-btn') as HTMLElement | null;
const mcpPopover = document.getElementById('mcp-tools-popover') as HTMLElement | null;

function toggleMcpPopover(force?: boolean) {
  if (!mcpPopover) return;
  const hidden = mcpPopover.hasAttribute('hidden');
  const nextHidden = force === undefined ? !hidden : !force;
  if (nextHidden) {
    mcpPopover.setAttribute('hidden', '');
  } else {
    mcpPopover.removeAttribute('hidden');
  }
}

let currentStreamingMessage: HTMLElement | null = null;
let currentStreamingBody: HTMLElement | null = null;
let streamingText = '';
let streamingThinkingBody: HTMLElement | null = null;
let activeModelLabel = '';
let fallbackMode = false;
let modelContexts: Record<string, number> = {};
let lastBudgetUsed = 0;

// Initial model sync
vscode.postMessage({ type: 'getModels' });

function fmtBudgetTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

function renderBudget(used: number, total: number) {
  if (!budgetValue || !budgetFill) return;
  lastBudgetUsed = used;
  const pct = Math.min(100, Math.round((used / total) * 100));
  budgetValue.textContent = `${fmtBudgetTokens(used)} / ${fmtBudgetTokens(total)} tokens`;
  budgetFill.style.width = `${pct}%`;
  if (pct > 90) {
    budgetFill.style.backgroundColor = '#f85149';
  } else if (pct > 70) {
    budgetFill.style.backgroundColor = '#d29922';
  } else {
    budgetFill.style.backgroundColor = '#2ea44f';
  }
}

function showWelcome() {
  welcomeState.style.display = 'flex';
  chatLog.style.display = 'none';
}

function ensureThinkingBody(): HTMLElement | null {
  if (streamingThinkingBody && currentStreamingMessage?.contains(streamingThinkingBody)) {
    return streamingThinkingBody;
  }
  if (!currentStreamingMessage) return null;
  const wrapper = document.createElement('details');
  wrapper.className = 'thinking-block';
  wrapper.innerHTML = '<summary>Model thinking…</summary><pre class="thinking-text"></pre>';
  currentStreamingMessage.appendChild(wrapper);
  streamingThinkingBody = wrapper.querySelector('.thinking-text') as HTMLElement;
  return streamingThinkingBody;
}

function showChat() {
  welcomeState.style.display = 'none';
  chatLog.style.display = 'flex';
}

function modelCaps(): string {
  const short = (activeModelLabel || '').split('/').pop() || '';
  return short.toUpperCase();
}

function setFallbackMode(active: boolean) {
  fallbackMode = active;
  modelSelect.classList.toggle('fallback-model', active);
  for (let i = 0; i < modelSelect.options.length; i++) {
    const opt = modelSelect.options[i];
    opt.textContent = opt.value.replace(/ \(fallback\)$/, '') + (active && opt.selected ? ' (fallback)' : '');
  }
}

function appendMessage(sender: 'user' | 'agent', text: string, opts?: { streaming?: boolean }): HTMLElement {
  const msg = document.createElement('div');
  msg.className = `message ${sender}`;

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let authorHtml: string;
  let rightHtml: string;
  if (sender === 'agent' && opts?.streaming) {
    const caps = modelCaps();
    authorHtml = `ForgePilot${caps ? ` <span class="model-caps">${escapeHtml(caps)}</span>` : ''}`;
    rightHtml = '<span class="streaming-badge"><span class="streaming-dot"></span>Streaming</span>';
  } else {
    authorHtml = sender === 'user' ? 'YOU' : 'ForgePilot';
    rightHtml = escapeHtml(now);
  }

  msg.innerHTML = `
    <div class="msg-header">
      <span class="msg-author">${authorHtml}</span>
      <span class="msg-time">${rightHtml}</span>
    </div>
    <div class="msg-body">${formatMessageBody(text)}</div>
  `;

  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function formatMessageBody(text: string): string {
  // Format code blocks ```lang ... ```
  let formatted = escapeHtml(text);
  formatted = formatted.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    return `<div class="code-block-container" style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 4px; margin: 6px 0; overflow: hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 3px 8px; background: rgba(255,255,255,0.05); font-size: 10px; color: var(--fg-secondary);">
        <span>${lang || 'code'}</span>
        <button class="copy-btn text-btn" onclick="navigator.clipboard.writeText(this.dataset.code)" data-code="${code.replace(/"/g, '&quot;')}">Copy</button>
      </div>
      <pre style="margin: 0; padding: 8px; font-size: 11px; overflow-x: auto;"><code>${code}</code></pre>
    </div>`;
  });

  // Format inline `code`
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  return formatted;
}

// ===== Structured "Context Chosen" card (Figma: Active Session) =====
interface ContextRow { path: string; reason: string }

function renderContextCard(rows: ContextRow[], title = 'Context Chosen') {
  const card = document.createElement('div');
  card.className = 'context-card';
  const header = document.createElement('div');
  header.className = 'context-card-header';
  header.innerHTML = `
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
    <span class="context-card-title">${escapeHtml(title)}</span>
    <span class="context-card-badge">${rows.length} Files</span>`;
  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'context-rows';
  for (const row of rows) {
    const item = document.createElement('button');
    item.className = 'context-row';
    item.title = `Open ${row.path}`;
    item.innerHTML = `
      <svg class="context-row-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
      <span class="context-row-main">
        <span class="context-row-path">${escapeHtml(row.path)}</span>
        <span class="context-row-reason">${escapeHtml(row.reason)}</span>
      </span>
      <svg class="context-row-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    item.addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile', path: row.path });
    });
    list.appendChild(item);
  }
  card.appendChild(list);
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function parseContextChosenRows(fullText: string): ContextRow[] {
  const lines = (fullText || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /context\s*chosen/i.test(l));
  if (start === -1) return [];
  const rows: ContextRow[] = [];
  for (let i = start + 1; i < lines.length && rows.length < 12; i++) {
    const raw = lines[i].trim();
    if (!raw) {
      if (rows.length > 0) break;
      continue;
    }
    const line = raw.replace(/^(?:[-*•]|\d+[.)])\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
    const m = line.match(/^([`'"]?)([^\s`'":,*–—-][^\s`'":–—]*[./\\][^\s`'":–—]*)\1\s*(?:[:–—-]|-\s)\s*(.+)$/);
    if (m) {
      rows.push({ path: m[2].trim(), reason: m[3].replace(/\*\*/g, '').trim() });
      continue;
    }
    const m2 = line.match(/^([`'"]?)(\S+\.\w{1,6})\1\s*(?:[:–—-]|-\s)\s*(.+)$/);
    if (m2) {
      rows.push({ path: m2[2].trim(), reason: m2[3].replace(/\*\*/g, '').trim() });
      continue;
    }
    if (rows.length > 0) break;
  }
  return rows;
}

// ===== Executed MCP tool log (Figma: Active Session) =====
let toolLogGroup: HTMLElement | null = null;
let toolLogTotalMs = 0;
const toolLogRows = new Map<string, HTMLElement>();

const TOOL_ICONS: Record<string, string> = {
  list_dir: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><line x1="8" y1="10" x2="16" y2="10"></line><line x1="8" y1="14" x2="13" y2="14"></line>',
  read_file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
  search_text: '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line>',
  find_symbol: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle>',
  get_context_budget_info: '<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="12" x2="15" y2="9"></line>',
};

function resetToolLog() {
  toolLogGroup = null;
  toolLogTotalMs = 0;
  toolLogRows.clear();
}

function ensureToolLogGroup(): HTMLElement {
  if (toolLogGroup && chatLog.contains(toolLogGroup)) return toolLogGroup;
  const group = document.createElement('div');
  group.className = 'tool-log-card';
  group.innerHTML = `
    <div class="tool-log-header">
      <span class="tool-log-title">EXECUTED MCP TOOL LOG</span>
      <span class="tool-log-total">0ms total</span>
    </div>
    <div class="tool-log-rows"></div>`;
  chatLog.appendChild(group);
  toolLogGroup = group;
  toolLogTotalMs = 0;
  toolLogRows.clear();
  return group;
}

function condensedArgs(name: string, args: any): string {
  if (!args || typeof args !== 'object') return '';
  try {
    if (typeof args.path === 'string') {
      const range = args.startLine != null && args.endLine != null ? `:${args.startLine}-${args.endLine}` : '';
      return `${args.path}${range}`;
    }
    if (typeof args.query === 'string') return `"${args.query}"${args.glob ? ' in ' + args.glob : ''}`;
    if (typeof args.name === 'string') return args.name;
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    if (keys.length === 1) return String(args[keys[0]]).slice(0, 80);
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return '';
  }
}

function toolIconKey(name: string): string {
  const n = (name || '').toLowerCase();
  for (const key of Object.keys(TOOL_ICONS)) {
    if (n.includes(key)) return key;
  }
  return n.startsWith('subagent') ? 'subagent' : '';
}

function appendToolLogRow(msg: any) {
  const group = ensureToolLogGroup();
  const rows = group.querySelector('.tool-log-rows') as HTMLElement;
  const existing = msg.toolCallId ? toolLogRows.get(msg.toolCallId) : undefined;
  if (existing) {
    if (msg.badge) {
      const badge = existing.querySelector('.tool-log-badge') as HTMLElement;
      if (badge) {
        badge.textContent = msg.badge;
        badge.classList.toggle('done', /done/i.test(msg.badge));
      }
    }
    return;
  }

  const iconKey = toolIconKey(msg.name);
  const iconSvg = iconKey && TOOL_ICONS[iconKey]
    ? TOOL_ICONS[iconKey]
    : '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>';

  const row = document.createElement('div');
  row.className = 'tool-log-row';
  row.innerHTML = `
    <svg class="tool-log-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg>
    <span class="tool-log-name">${escapeHtml(msg.name)}</span>
    <span class="tool-log-args">${escapeHtml(condensedArgs(msg.name, msg.args))}</span>
    <span class="tool-log-badge">${escapeHtml(msg.badge || '')}</span>
    <svg class="tool-log-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  if (msg.toolCallId) toolLogRows.set(msg.toolCallId, row);

  row.addEventListener('click', () => {
    let detail = row.nextElementSibling as HTMLElement | null;
    if (detail && detail.classList.contains('tool-log-detail')) {
      detail.remove();
      return;
    }
    detail = document.createElement('pre');
    detail.className = 'tool-log-detail';
    detail.textContent = JSON.stringify(msg.args ?? {}, null, 2);
    row.after(detail);
  });

  rows.appendChild(row);

  if (typeof msg.durationMs === 'number') {
    toolLogTotalMs += msg.durationMs;
    const total = group.querySelector('.tool-log-total') as HTMLElement;
    if (total) total.textContent = `${Math.max(1, Math.round(toolLogTotalMs))}ms total`;
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ===== Pending (approval-gated) tool action card =====
function appendPendingActionCard(toolName: string, args: any) {
  const card = document.createElement('div');
  card.className = 'pending-tool-card';
  const target = args && typeof args === 'object' ? (args.path ?? args.command ?? '') : '';
  card.innerHTML = `
    <div class="pending-tool-header">
      <span class="pending-tool-title">PENDING TOOL ACTION</span>
      <span class="pending-tool-note">Requires Confirmation</span>
    </div>
    <div class="pending-tool-body">
      <span class="pending-tool-icon">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>
      </span>
      <span class="pending-tool-main">
        <span class="pending-tool-name">${escapeHtml(toolName)} <code>${escapeHtml(String(target).slice(0, 60))}</code></span>
        <span class="pending-tool-sub">${toolName === 'propose_write' && args?.newContent != null ? 'Add/update file with proposed content' : 'Waiting for your approval to run'}</span>
      </span>
      <span class="pending-tool-badge">Awaiting Approval</span>
    </div>`;
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendToolCard(name: string, args: any, isDestructive: boolean = false) {
  if (name === 'propose_write') {
    // Propose write is displayed exclusively via the dedicated proposal review card
    return;
  }
  if (isDestructive) {
    appendPendingActionCard(name, args);
    return;
  }
  appendToolLogRow({ toolCallId: undefined, name, args, badge: '', durationMs: undefined });
}

// ===== Figma proposal review card (per-hunk accept/reject) =====
function appendProposalReview(proposalId: string, filePath: string, hunks: any[], toolCallId?: string) {
  const card = document.createElement('div');
  card.className = 'proposal-review';
  card.id = `proposal-${proposalId}`;

  let adds = 0, dels = 0;
  for (const h of hunks) {
    for (const l of h.lines || []) {
      if (l.startsWith('+')) adds++;
      else if (l.startsWith('-')) dels++;
    }
  }

  card.innerHTML = `
    <div class="proposal-header">
      <span class="proposal-file">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
        <span class="proposal-path">${escapeHtml(filePath)}</span>
        <span class="proposal-delta"><span class="delta-add">+${adds}</span> <span class="delta-del">−${dels}</span></span>
      </span>
      <div class="proposal-actions">
        <button class="open-diff-btn">Open Diff</button>
        <button class="accept-proposal-btn" title="Accept all hunks and save to disk">✓ Accept & Save</button>
      </div>
    </div>
    <div class="hunk-list"></div>
    <div class="proposal-footer">
      <button class="reject-all-btn">Reject All</button>
      <span class="flex-spacer"></span>
      <button class="accept-all-btn">Accept All</button>
      <button class="apply-accepted-btn" disabled>Apply Accepted (<span class="accepted-count">0</span>/${hunks.length})</button>
    </div>`;

  const hunkList = card.querySelector('.hunk-list') as HTMLElement;
  const applyBtn = card.querySelector('.apply-accepted-btn') as HTMLButtonElement;
  const acceptedCountEl = card.querySelector('.accepted-count') as HTMLElement;
  const decisions = new Map<string, 'accepted' | 'rejected'>();

  const updateApplyButton = () => {
    const count = Array.from(decisions.values()).filter((d) => d === 'accepted').length;
    acceptedCountEl.textContent = String(count);
    applyBtn.disabled = count === 0;
  };

  const setDecision = (hunkId: string, decision: 'accepted' | 'rejected' | null, rowEl: HTMLElement) => {
    if (decision === null) {
      decisions.delete(hunkId);
      rowEl.classList.remove('accepted', 'rejected');
    } else {
      decisions.set(hunkId, decision);
      rowEl.classList.toggle('accepted', decision === 'accepted');
      rowEl.classList.toggle('rejected', decision === 'rejected');
      vscode.postMessage({ type: 'hunkDecision', proposalId, hunkId: hunkId, decision });
    }
    updateApplyButton();
  };

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    const row = document.createElement('div');
    row.className = 'hunk-row-item';
    row.id = `hunk-${hunk.id}`;

    const addedLine = (hunk.lines || []).find((l: string) => l.startsWith('+'));
    const reason = addedLine
      ? addedLine.slice(1).trim().slice(0, 76) || `Hunk ${idx + 1}`
      : `Hunk ${idx + 1}`;

    const endLine = hunk.oldStart + Math.max(hunk.oldLines - 1, 0);
    row.innerHTML = `
      <div class="hunk-row">
        <div class="hunk-info">
          <div class="hunk-title">hunk ${idx + 1} <span class="hunk-range">· L${hunk.oldStart}–L${endLine}</span></div>
          <div class="hunk-reason">${escapeHtml(reason)}</div>
        </div>
        <div class="hunk-quick">
          <button class="hunk-accept-btn" title="Accept this hunk and apply to file"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 10"></polyline></svg></button>
          <button class="hunk-reject-btn" title="Reject this hunk"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        </div>
      </div>`;

    const acceptBtn = row.querySelector('.hunk-accept-btn') as HTMLButtonElement;
    const rejectBtn = row.querySelector('.hunk-reject-btn') as HTMLButtonElement;
    acceptBtn.addEventListener('click', () => {
      setDecision(hunk.id, 'accepted', row);
      // Automatically apply when the user presses the tick button
      vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow', toolCallId });
    });
    rejectBtn.addEventListener('click', () => {
      setDecision(hunk.id, 'rejected', row);
      if (hunks.length === 1) {
        vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'deny', toolCallId });
      }
    });

    hunkList.appendChild(row);
  }

  card.querySelector('.accept-proposal-btn')?.addEventListener('click', () => {
    for (let idx = 0; idx < hunks.length; idx++) {
      const hunk = hunks[idx];
      const rowEl = card.querySelector(`#hunk-${CSS.escape(hunk.id)}`) as HTMLElement;
      setDecision(hunk.id, 'accepted', rowEl);
    }
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow', toolCallId });
  });

  card.querySelector('.accept-all-btn')?.addEventListener('click', () => {
    for (let idx = 0; idx < hunks.length; idx++) {
      const hunk = hunks[idx];
      const rowEl = card.querySelector(`#hunk-${CSS.escape(hunk.id)}`) as HTMLElement;
      setDecision(hunk.id, 'accepted', rowEl);
    }
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow', toolCallId });
  });

  card.querySelector('.reject-all-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'deny', toolCallId });
  });

  applyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow', toolCallId });
  });

  card.querySelector('.open-diff-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openDiff', proposalId });
  });

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showProposalOutcome(proposalId: string, appliedCount: number, totalCount: number, filePath?: string) {
  const card = document.getElementById(`proposal-${proposalId}`);
  if (!card) return;
  card.classList.add('resolved');
  const applied = appliedCount > 0;
  const headerActions = card.querySelector('.proposal-actions') as HTMLElement | null;
  if (headerActions) {
    headerActions.innerHTML = applied
      ? `<span class="proposal-outcome applied">✓ Saved</span>`
      : `<span class="proposal-outcome rejected">✕ Rejected</span>`;
  }
  const footer = card.querySelector('.proposal-footer') as HTMLElement | null;
  if (footer) {
    footer.innerHTML = applied
      ? `<span class="proposal-outcome applied">✓ Applied ${appliedCount}/${totalCount} hunks and saved to ${escapeHtml(filePath || '')}</span>`
      : `<span class="proposal-outcome rejected">Proposal rejected — workspace unchanged</span>`;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function handleSend() {
  const text = promptInput.value.trim();
  if (!text) return;

  showChat();
  resetToolLog();
  streamingText = '';
  streamingThinkingBody = null;
  appendMessage('user', text);
  promptInput.value = '';
  renderAttachChips();
  cancelBtn.style.display = 'inline-flex';
  sendBtn.disabled = true;

  currentStreamingMessage = appendMessage('agent', '', { streaming: true });
  currentStreamingBody = currentStreamingMessage.querySelector('.msg-body');

  vscode.postMessage({ type: 'sendMessage', text });
}

function handleCancel() {
  vscode.postMessage({ type: 'cancel' });
  cancelBtn.style.display = 'none';
  sendBtn.disabled = false;
  if (currentStreamingBody) {
    const badge = currentStreamingMessage?.querySelector('.streaming-badge');
    if (badge) badge.outerHTML = '<span class="streaming-badge cancelled">Cancelled</span>';
    currentStreamingBody.innerHTML += '<br/><span style="color: #ff9800;">[⏹ Turn cancelled by user. Workspace remains 100% clean.]</span>';
    currentStreamingMessage = null;
    currentStreamingBody = null;
  }
}

// Model dropdown change
modelSelect.addEventListener('change', () => {
  const chosen = modelSelect.value;
  vscode.postMessage({ type: 'selectModel', model: chosen });
});

refreshModelsBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'getModels' });
});

resetSessionBtn.addEventListener('click', () => {
  chatLog.innerHTML = '';
  resetToolLog();
  streamingText = '';
  streamingThinkingBody = null;
  setFallbackMode(false);
  showWelcome();
  vscode.postMessage({ type: 'resetSession' });
});

chipFile.addEventListener('click', () => {
  vscode.postMessage({ type: 'pickFileMention' });
});

mcpToolsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMcpPopover();
});

document.addEventListener('click', (e) => {
  if (!mcpPopover || mcpPopover.hasAttribute('hidden')) return;
  const target = e.target as HTMLElement;
  if (target.closest('#mcp-tools-popover') || target.closest('#mcp-tools-btn')) return;
  toggleMcpPopover(false);
});

chipSymbol.addEventListener('click', () => {
  vscode.postMessage({ type: 'pickSymbolMention' });
});

// Suggestion chips on the welcome screen prefill + send
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.suggestion'))) {
  btn.addEventListener('click', () => {
    const prompt = btn.dataset.prompt;
    if (!prompt) return;
    promptInput.value = prompt;
    handleSend();
  });
}

// Render removable mention chips (@file:..., @symbol:...) above the composer
const MENTION_RE = /(?:^|\s)(@(?:file|symbol):[^\s]+)/g;

function renderAttachChips() {
  if (!attachChips) return;
  const tokens = (promptInput.value.match(MENTION_RE) || []).map((t) => t.trim());
  attachChips.innerHTML = '';
  for (const token of tokens) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    const label = document.createElement('span');
    label.textContent = token;
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Remove mention';
    remove.addEventListener('click', () => {
      promptInput.value = promptInput.value.replace(token, '').replace(/\s{2,}/g, ' ').trim();
      renderAttachChips();
    });
    chip.appendChild(label);
    chip.appendChild(remove);
    attachChips.appendChild(chip);
  }
}

promptInput.addEventListener('input', renderAttachChips);

sendBtn.addEventListener('click', handleSend);
cancelBtn.addEventListener('click', handleCancel);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleMcpPopover(false);
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    handleSend();
  }
});

// Incoming message dispatcher
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'modelsList':
      if (msg.contexts && typeof msg.contexts === 'object') {
        modelContexts = msg.contexts;
      }
      if (Array.isArray(msg.models) && msg.models.length > 0) {
        modelSelect.innerHTML = '';
        for (const m of msg.models) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === msg.activeModel) {
            opt.selected = true;
          }
          modelSelect.appendChild(opt);
        }
        if (msg.activeModel) activeModelLabel = msg.activeModel;
        setFallbackMode(fallbackMode);
      }
      break;

    case 'status':
      if (msg.model) {
        activeModelLabel = msg.model;
        for (let i = 0; i < modelSelect.options.length; i++) {
          if (modelSelect.options[i].value === msg.model) {
            modelSelect.selectedIndex = i;
            break;
          }
        }
        setFallbackMode(msg.fallback === true);
        const total = modelContexts[msg.model] ?? 32768;
        renderBudget(lastBudgetUsed, total);
      }
      break;

    case 'budgetUpdate': {
      const modelTotal = modelContexts[activeModelLabel] ?? 32768;
      const total = msg.total ?? modelTotal;
      renderBudget(msg.used ?? 0, total);
      break;
    }

    case 'fallbackActivated': {
      setFallbackMode(true);
      // Finalize the failed model's bubble: swap the Streaming badge for a
      // marker, format whatever partial text arrived, then start fresh —
      // subsequent deltas open a new bubble in the fallback model's header.
      if (currentStreamingMessage) {
        const badge = currentStreamingMessage.querySelector('.streaming-badge');
        if (badge) badge.outerHTML = '<span class="failed-marker">Failed</span>';
      }
      if (currentStreamingBody) {
        currentStreamingBody.innerHTML = formatMessageBody(currentStreamingBody.textContent || '(no output — model request failed)');
      }
      currentStreamingMessage = null;
      currentStreamingBody = null;
      streamingText = '';
      const banner = document.createElement('div');
      banner.className = 'fallback-banner';
      const to = escapeHtml(String(msg.to ?? 'fallback model'));
      const maxRetries = msg.maxRetries ?? 3;
      const attempts = msg.attempts ?? maxRetries;
      banner.innerHTML = `
        <div class="fallback-banner-header">
          <span class="fallback-banner-title">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            FALLBACK ACTIVATED
          </span>
          <span class="fallback-banner-retry">Retry ${attempts}/${maxRetries}</span>
        </div>
        <div class="fallback-banner-body">Primary model unreachable — re-routed automatically to <strong>${to}</strong>. Workspace unchanged (0 files modified).</div>`;
      chatLog.appendChild(banner);
      chatLog.scrollTop = chatLog.scrollHeight;
      break;
    }

    case 'session':
      if (sessionLabel) {
        sessionLabel.textContent = msg.label || 'Fresh Session';
      }
      break;

    case 'tokenDelta':
      // Deltas may arrive after a silent fallback reset the streaming refs;
      // start a fresh streaming bubble in the fallback model's header style.
      if (!currentStreamingBody) {
        currentStreamingMessage = appendMessage('agent', '', { streaming: true });
        currentStreamingBody = currentStreamingMessage.querySelector('.msg-body');
      }
      streamingText += msg.text;
      currentStreamingBody.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
      break;

    case 'reasoningDelta': {
      // Reasoning models stream chain-of-thought separately from the answer;
      // show it in a collapsible, muted block rather than the main bubble.
      const pre = ensureThinkingBody();
      if (pre) {
        pre.textContent += msg.text;
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      break;
    }

    case 'insertMention':
      if (typeof msg.mention === 'string' && msg.mention.length > 0) {
        const sep = promptInput.value.trimEnd().length > 0 ? ' ' : '';
        promptInput.value = `${promptInput.value.trimEnd()}${sep}${msg.mention} `;
        renderAttachChips();
        promptInput.focus();
      }
      break;

    case 'toolCall':
      appendToolCard(msg.name, msg.args, msg.isDestructive);
      break;

    case 'toolLog':
      appendToolLogRow(msg);
      break;

    case 'proposalReview':
      appendProposalReview(msg.proposalId, msg.filePath, msg.hunks, msg.toolCallId);
      break;

    case 'proposalApplied':
      showProposalOutcome(msg.proposalId, msg.appliedCount, msg.totalCount, msg.filePath);
      break;

    case 'contextChosen':
      if (Array.isArray(msg.items) && msg.items.length > 0) {
        renderContextCard(
          msg.items.map((it: any) => ({ path: String(it.target), reason: String(it.reason ?? '') })),
          'Context Chosen'
        );
      } else if (msg.text) {
        renderContextCard([{ path: '@mentions', reason: String(msg.text).slice(0, 300) }], 'Context Chosen');
      }
      break;

    case 'turnDone': {
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      if (currentStreamingMessage) {
        const badge = currentStreamingMessage.querySelector('.streaming-badge');
        if (badge) badge.outerHTML = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (currentStreamingBody) {
        currentStreamingBody.innerHTML = formatMessageBody(currentStreamingBody.textContent || '');
      }
      const contextRows = parseContextChosenRows(streamingText);
      if (contextRows.length > 0) {
        renderContextCard(contextRows, 'Context Chosen');
      }
      currentStreamingMessage = null;
      currentStreamingBody = null;
      break;
    }

    case 'error':
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      appendMessage('agent', `❌ Error: ${msg.message}`);
      currentStreamingMessage = null;
      currentStreamingBody = null;
      break;
  }
});

declare function acquireVsCodeApi(): {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };

// DOM Elements
const chatLog = document.getElementById('chat-log') as HTMLElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const refreshModelsBtn = document.getElementById('refresh-models-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;
const budgetValue = document.getElementById('budget-value') as HTMLElement;
const budgetFill = document.getElementById('budget-progress-fill') as HTMLElement;
const clearChatBtn = document.getElementById('clear-chat-btn') as HTMLButtonElement;
const chipFile = document.getElementById('chip-file') as HTMLElement;
const chipSymbol = document.getElementById('chip-symbol') as HTMLElement;

let currentStreamingMessage: HTMLElement | null = null;
let currentStreamingBody: HTMLElement | null = null;

// Initial model sync
vscode.postMessage({ type: 'getModels' });

function appendMessage(sender: 'user' | 'agent', text: string): HTMLElement {
  const msg = document.createElement('div');
  msg.className = `message ${sender}`;

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const author = sender === 'user' ? '👤 You' : '🤖 ForgePilot';

  msg.innerHTML = `
    <div class="msg-header">
      <span class="msg-author">${escapeHtml(author)}</span>
      <span class="msg-time">${now}</span>
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

function appendContextCard(text: string) {
  const card = document.createElement('div');
  card.className = 'context-card';
  card.innerHTML = `
    <div class="context-title">📌 Context Chosen for this Task:</div>
    <div class="context-body">${escapeHtml(text)}</div>
  `;
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendToolCard(name: string, args: any, isDestructive: boolean = false) {
  const card = document.createElement('div');
  card.className = `tool-card ${isDestructive ? 'destructive' : ''}`;
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span class="tool-name">⚡ Tool: <code>${escapeHtml(name)}</code></span>
      ${isDestructive ? '<span style="color: #ffa726; font-size: 10px; font-weight:600;">[APPROVAL GATED]</span>' : ''}
    </div>
    <pre style="margin: 4px 0 0 0; font-size: 11px; background: rgba(0,0,0,0.2); padding: 4px; border-radius: 3px; max-height: 120px; overflow-y: auto;">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
  `;
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendProposalReview(proposalId: string, filePath: string, hunks: any[]) {
  const container = document.createElement('div');
  container.className = 'proposal-review';
  container.id = `proposal-${proposalId}`;

  container.innerHTML = `
    <div class="proposal-header">
      <span class="proposal-file-badge">📄 ${escapeHtml(filePath)}</span>
      <div class="proposal-actions">
        <button class="success-btn accept-all-btn">✓ Accept All (${hunks.length})</button>
        <button class="danger-btn reject-all-btn">✗ Reject All</button>
      </div>
    </div>
    <div class="hunks-list"></div>
  `;

  const hunksList = container.querySelector('.hunks-list') as HTMLElement;
  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    const hunkEl = document.createElement('div');
    hunkEl.className = 'hunk-item';
    hunkEl.id = `hunk-${hunk.id}`;

    const diffLines = hunk.lines.map((l: string) => {
      let cls = '';
      if (l.startsWith('+')) cls = 'add';
      else if (l.startsWith('-')) cls = 'del';
      return `<div class="hunk-diff-line ${cls}">${escapeHtml(l)}</div>`;
    }).join('');

    hunkEl.innerHTML = `
      <div class="hunk-header">
        <span><strong>Hunk ${idx + 1} of ${hunks.length}</strong> (Lines: ${hunk.oldStart} ➔ ${hunk.newStart})</span>
        <span class="hunk-status-badge pending" id="status-${hunk.id}">Pending</span>
      </div>
      <div class="hunk-diff-container">${diffLines}</div>
      <div class="hunk-controls">
        <button class="success-btn accept-hunk-btn" data-hunk-id="${hunk.id}">Accept Hunk</button>
        <button class="secondary-btn reject-hunk-btn" data-hunk-id="${hunk.id}">Reject Hunk</button>
      </div>
    `;

    hunkEl.querySelector('.accept-hunk-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'hunkDecision', proposalId, hunkId: hunk.id, decision: 'accepted' });
      const badge = hunkEl.querySelector(`#status-${hunk.id}`) as HTMLElement;
      if (badge) {
        badge.className = 'hunk-status-badge accepted';
        badge.textContent = 'Accepted';
      }
      hunkEl.style.borderColor = 'var(--success)';
    });

    hunkEl.querySelector('.reject-hunk-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'hunkDecision', proposalId, hunkId: hunk.id, decision: 'rejected' });
      const badge = hunkEl.querySelector(`#status-${hunk.id}`) as HTMLElement;
      if (badge) {
        badge.className = 'hunk-status-badge rejected';
        badge.textContent = 'Rejected';
      }
      hunkEl.style.borderColor = 'var(--danger)';
    });

    hunksList.appendChild(hunkEl);
  }

  container.querySelector('.accept-all-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow' });
    container.style.opacity = '0.7';
    container.querySelectorAll('.hunk-status-badge').forEach((b) => {
      b.className = 'hunk-status-badge accepted';
      b.textContent = 'Accepted';
    });
  });

  container.querySelector('.reject-all-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'deny' });
    container.style.opacity = '0.7';
    container.querySelectorAll('.hunk-status-badge').forEach((b) => {
      b.className = 'hunk-status-badge rejected';
      b.textContent = 'Rejected';
    });
  });

  chatLog.appendChild(container);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function handleSend() {
  const text = promptInput.value.trim();
  if (!text) return;

  appendMessage('user', text);
  promptInput.value = '';
  cancelBtn.style.display = 'inline-flex';
  sendBtn.disabled = true;

  currentStreamingMessage = appendMessage('agent', '');
  currentStreamingBody = currentStreamingMessage.querySelector('.msg-body');

  vscode.postMessage({ type: 'sendMessage', text });
}

function handleCancel() {
  vscode.postMessage({ type: 'cancel' });
  cancelBtn.style.display = 'none';
  sendBtn.disabled = false;
  if (currentStreamingBody) {
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

clearChatBtn.addEventListener('click', () => {
  chatLog.innerHTML = '';
});

chipFile.addEventListener('click', () => {
  promptInput.value += '@file:';
  promptInput.focus();
});

chipSymbol.addEventListener('click', () => {
  promptInput.value += '@symbol:';
  promptInput.focus();
});

sendBtn.addEventListener('click', handleSend);
cancelBtn.addEventListener('click', handleCancel);

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
      }
      break;

    case 'status':
      if (msg.model) {
        for (let i = 0; i < modelSelect.options.length; i++) {
          if (modelSelect.options[i].value === msg.model) {
            modelSelect.selectedIndex = i;
            break;
          }
        }
      }
      break;

    case 'tokenDelta':
      if (currentStreamingBody) {
        currentStreamingBody.textContent += msg.text;
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      break;

    case 'toolCall':
      appendToolCard(msg.name, msg.args, msg.isDestructive);
      break;

    case 'proposalReview':
      appendProposalReview(msg.proposalId, msg.filePath, msg.hunks);
      break;

    case 'contextChosen':
      appendContextCard(msg.text);
      break;

    case 'turnDone':
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      if (currentStreamingBody) {
        currentStreamingBody.innerHTML = formatMessageBody(currentStreamingBody.textContent || '');
      }
      currentStreamingMessage = null;
      currentStreamingBody = null;
      break;

    case 'error':
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      appendMessage('agent', `❌ Error: ${msg.message}`);
      currentStreamingMessage = null;
      currentStreamingBody = null;
      break;
  }
});

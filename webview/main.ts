declare function acquireVsCodeApi(): {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };

const chatLog = document.getElementById('chat-log') as HTMLElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelBadge = document.getElementById('model-badge') as HTMLElement;

let currentStreamingMessage: HTMLElement | null = null;

function appendMessage(sender: 'user' | 'agent', text: string): HTMLElement {
  const msg = document.createElement('div');
  msg.className = `message ${sender}`;
  msg.textContent = text;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function appendToolCard(name: string, args: any, isDestructive: boolean = false): HTMLElement {
  const card = document.createElement('div');
  card.className = `tool-card ${isDestructive ? 'destructive' : ''}`;
  card.innerHTML = `<strong>Tool Call:</strong> <code>${escapeHtml(name)}</code><pre style="margin: 4px 0; font-size: 11px;">${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
  return card;
}

function appendProposalReview(proposalId: string, filePath: string, hunks: any[]) {
  const container = document.createElement('div');
  container.className = 'proposal-review';
  container.id = `proposal-${proposalId}`;

  container.innerHTML = `
    <div class="proposal-title">📝 Proposed Edits: <code>${escapeHtml(filePath)}</code> (${hunks.length} hunks)</div>
    <div class="hunks-list"></div>
    <div style="margin-top: 8px; display: flex; gap: 6px;">
      <button class="success accept-all-btn">Accept All Hunks</button>
      <button class="danger reject-all-btn">Reject All Hunks</button>
    </div>
  `;

  const hunksList = container.querySelector('.hunks-list') as HTMLElement;
  for (const hunk of hunks) {
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
      <div style="font-size: 11px; color: #888;">Lines: ${hunk.oldStart} - ${hunk.newStart}</div>
      <div style="font-family: monospace; font-size: 11px; margin: 4px 0;">${diffLines}</div>
      <div class="hunk-actions">
        <button class="success accept-hunk-btn" data-hunk-id="${hunk.id}">Accept Hunk</button>
        <button class="secondary reject-hunk-btn" data-hunk-id="${hunk.id}">Reject Hunk</button>
      </div>
    `;

    hunkEl.querySelector('.accept-hunk-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'hunkDecision', proposalId, hunkId: hunk.id, decision: 'accepted' });
      hunkEl.style.opacity = '0.6';
      hunkEl.style.borderColor = '#28a745';
    });

    hunkEl.querySelector('.reject-hunk-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'hunkDecision', proposalId, hunkId: hunk.id, decision: 'rejected' });
      hunkEl.style.opacity = '0.6';
      hunkEl.style.borderColor = '#dc3545';
    });

    hunksList.appendChild(hunkEl);
  }

  container.querySelector('.accept-all-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'allow' });
    container.style.opacity = '0.5';
  });

  container.querySelector('.reject-all-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'proposalDecision', proposalId, decision: 'deny' });
    container.style.opacity = '0.5';
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
  cancelBtn.style.display = 'inline-block';
  sendBtn.disabled = true;

  currentStreamingMessage = appendMessage('agent', '');
  vscode.postMessage({ type: 'sendMessage', text });
}

function handleCancel() {
  vscode.postMessage({ type: 'cancel' });
  cancelBtn.style.display = 'none';
  sendBtn.disabled = false;
  if (currentStreamingMessage) {
    currentStreamingMessage.textContent += '\n[Cancelled by user. Workspace is completely unchanged.]';
    currentStreamingMessage = null;
  }
}

sendBtn.addEventListener('click', handleSend);
cancelBtn.addEventListener('click', handleCancel);

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    handleSend();
  }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'tokenDelta':
      if (currentStreamingMessage) {
        currentStreamingMessage.textContent += msg.text;
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
      const ctxCard = document.createElement('div');
      ctxCard.className = 'context-card';
      ctxCard.innerHTML = `<strong>Context Chosen:</strong><pre style="margin: 4px 0; font-size: 11px;">${escapeHtml(msg.text)}</pre>`;
      chatLog.appendChild(ctxCard);
      chatLog.scrollTop = chatLog.scrollHeight;
      break;
    case 'status':
      if (modelBadge) {
        modelBadge.textContent = msg.model || 'TrueForge Ready';
      }
      break;
    case 'turnDone':
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      currentStreamingMessage = null;
      break;
    case 'error':
      cancelBtn.style.display = 'none';
      sendBtn.disabled = false;
      appendMessage('agent', `❌ Error: ${msg.message}`);
      currentStreamingMessage = null;
      break;
  }
});

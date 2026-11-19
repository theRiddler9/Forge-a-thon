import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { globalEditStaging } from '../edit/staging.js';
import { parseMentions, resolveMentions, formatContextBlock } from '../context/mentions.js';
import { globalContextBudget } from '../mcp/tools/contextBudget.js';

function extractToolResponseText(event: any): string {
  if (!event) return '';
  if (typeof event.content === 'string') return event.content;
  if (typeof event.output === 'string') return event.output;
  if (typeof event.result === 'string') return event.result;
  const candidates = [event.content, event.output, event.result];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      try {
        if (Array.isArray(c)) {
          return c.map((p: any) => p?.text ?? p?.content ?? JSON.stringify(p)).join('\n');
        }
        if (Array.isArray(c.content)) {
          return c.content.map((p: any) => p?.text ?? p?.content ?? JSON.stringify(p)).join('\n');
        }
        return JSON.stringify(c);
      } catch {
        return '';
      }
    }
  }
  return '';
}

function makeToolBadge(name: string, resultText: string, durationMs?: number): string {
  const lower = (name || '').toLowerCase();
  const lineCount = resultText ? resultText.split('\n').filter((l) => l.trim().length > 0).length : 0;
  if (lower.includes('read_file') && lineCount > 0) return `${lineCount} lines`;
  if (lower.includes('search_text') && lineCount > 0) return `${lineCount} hits`;
  if (lower.includes('list_dir') && lineCount > 0) return `${lineCount} items`;
  if (typeof durationMs === 'number') return `${Math.max(1, Math.round(durationMs))}ms`;
  return '';
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgepilot.agentView';
  private _view?: vscode.WebviewView;
  private currentSessionId?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: TrueForgeClient,
    private readonly workspaceRoot: string
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'getModels':
          await this._refreshModels();
          break;
        case 'openFile':
          await this._openFile(data.path, data.line);
          break;
        case 'openDiff':
          await this._openDiff(data.proposalId);
          break;
        case 'selectModel':
          this.client.setActiveModel(data.model);
          this.currentSessionId = undefined; // Reset session to use newly chosen model
          this.postMessage({
            type: 'status',
            model: data.model,
          });
          this.postMessage({ type: 'session', label: 'Fresh Session' });
          break;
        case 'resetSession':
          this.currentSessionId = undefined;
          globalEditStaging.clearAll();
          globalContextBudget.reset();
          this._refreshBudget();
          this.postMessage({ type: 'session', label: 'Fresh Session' });
          this.postMessage({ type: 'status', model: this.client.getActiveModel() });
          break;
        case 'sendMessage':
          await this._handleUserMessage(data.text);
          break;
        case 'cancel':
          await this._handleCancel();
          break;
        case 'hunkDecision':
          globalEditStaging.setHunkDecision(data.proposalId, data.hunkId, data.decision);
          break;
        case 'proposalDecision':
          await this._handleProposalDecision(data.proposalId, data.decision, data.toolCallId);
          break;
      }
    });

    this._refreshModels();
  }

  private async _refreshModels() {
    const models = await this.client.listAvailableModels();
    this.postMessage({
      type: 'modelsList',
      models,
      activeModel: this.client.getActiveModel(),
    });
    this.postMessage({
      type: 'status',
      model: this.client.getActiveModel(),
    });
    this._refreshBudget();
  }

  private _refreshBudget() {
    const info = globalContextBudget.getBudgetInfo();
    this.postMessage({
      type: 'budgetUpdate',
      used: info.usedTokens,
      total: info.totalBudget,
    });
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  private async _handleUserMessage(userInput: string) {
    try {
      const INSTRUCTIONS =
        'You are ForgePilot, an expert coding assistant. Before proposing file edits, summarize the chosen context and explain why each file was selected. Always use propose_write for file edits.';

      // 1. Resolve mentions
      const parsed = parseMentions(userInput);
      const resolvedContext = await resolveMentions(this.workspaceRoot, parsed);
      const contextBlock = formatContextBlock(resolvedContext);

      if (contextBlock) {
        this.postMessage({
          type: 'contextChosen',
          text: contextBlock,
          items: resolvedContext.map((it) => ({ type: it.type, target: it.target, reason: it.reason, tokens: it.tokens })),
        });
        this._refreshBudget();
      }

      const fullPrompt = contextBlock ? `${contextBlock}\n${userInput}` : userInput;

      // 2. Ensure session exists
      if (!this.currentSessionId) {
        const session = await this.client.createSessionWithFallback(INSTRUCTIONS);
        this.currentSessionId = session.id;
        this.postMessage({
          type: 'status',
          model: this.client.getActiveModel(),
          fallback: this.client.lastFallbackInfo != null,
        });
        const fb = this.client.lastFallbackInfo;
        if (fb) {
          this.postMessage({
            type: 'fallbackActivated',
            from: fb.from,
            to: fb.to,
            attempts: fb.attempts,
            maxRetries: fb.maxRetries,
          });
        }
        this.postMessage({
          type: 'session',
          label: `Session #${String(session.id).replace(/[^a-zA-Z0-9]/g, '').slice(-4)}`,
        });
      }

      // 3. Stream the turn with automatic model fallback on turn-time failure.
      // (Handlers are rebuilt per attempt; no proposal is staged before the
      // fallback decision, so a failed turn leaves the workspace untouched.)
      const makeHandlers = () => {
        const toolCalls = new Map<string, { name: string; args: any; start: number }>();
        return {
          onEvent: (event: any) => {
            const type = event?.type;
            if (type === 'model.message' && Array.isArray(event?.toolCalls)) {
              for (const tc of event.toolCalls) {
                toolCalls.set(tc.id, { name: tc?.name ?? 'tool', args: tc?.arguments ?? {}, start: Date.now() });
              }
              return;
            }
            if (type === 'tool.response') {
              const tcId = event?.toolCallId ?? event?.tool_call_id ?? event?.callId;
              const known = tcId ? toolCalls.get(tcId) : undefined;
              const name = known?.name ?? event?.name ?? 'tool';
              const durationMs = known ? Date.now() - known.start : undefined;
              const resultText = extractToolResponseText(event);
              this.postMessage({
                type: 'toolLog',
                toolCallId: tcId ?? `${Date.now()}-${name}`,
                name,
                args: known?.args,
                badge: makeToolBadge(name, resultText, durationMs),
                durationMs,
              });
              this._refreshBudget();
              return;
            }
            if (type === 'thread.created' && event?.threadId && event.threadId !== 'main') {
              this.postMessage({
                type: 'toolLog',
                toolCallId: event.threadId,
                name: `subagent: ${event?.name ?? event?.agent ?? 'explorer'}`,
                badge: 'Running',
                durationMs: 0,
              });
              return;
            }
            if (type === 'thread.done' && event?.threadId && event.threadId !== 'main') {
              this.postMessage({
                type: 'toolLog',
                toolCallId: event.threadId,
                name: `subagent: ${event?.name ?? event?.agent ?? 'explorer'}`,
                badge: 'Done',
                durationMs: 0,
              });
              return;
            }
          },
          onDelta: (text: string) => {
            this.postMessage({ type: 'tokenDelta', text });
          },
          onToolApprovalRequired: (toolCallId: string, toolName: string, args: any) => {
            this.postMessage({
              type: 'toolCall',
              id: toolCallId,
              name: toolName,
              args,
              isDestructive: true,
            });

            if (toolName === 'propose_write') {
              const proposal = globalEditStaging.stageProposal(
                this.workspaceRoot,
                args.path,
                args.newContent,
                toolCallId
              );
              this.postMessage({
                type: 'proposalReview',
                proposalId: proposal.proposalId,
                toolCallId,
                filePath: proposal.relativePath,
                hunks: proposal.hunks,
              });
            }
          },
          onError: (err: Error) => {
            this.postMessage({ type: 'error', message: err.message });
          },
        };
      };

      let outcome = await this.client.runTurn(this.currentSessionId!, fullPrompt, makeHandlers());

      // Automatic fallback: the configured primary model failed mid-turn.
      // Replay the identical prompt once on the fallback model.
      if (outcome.status === 'error' && this.client.hasFallback()) {
        const from = this.client.getActiveModel();
        const to = this.client.getFallbackModel()!;
        this.postMessage({ type: 'fallbackActivated', from, to, attempts: 1, maxRetries: 1 });
        try {
          const fbSession = await this.client.createSession(to, INSTRUCTIONS);
          this.client.markFallbackActivated();
          this.currentSessionId = fbSession.id;
          this.postMessage({ type: 'status', model: to, fallback: true });
          this.postMessage({
            type: 'session',
            label: `Session #${String(fbSession.id).replace(/[^a-zA-Z0-9]/g, '').slice(-4)}`,
          });
          outcome = await this.client.runTurn(fbSession.id, fullPrompt, makeHandlers());
        } catch (err: any) {
          outcome = { status: 'error', message: err?.message ?? String(err) };
        }
      }

      this._refreshBudget();
      if (outcome.status === 'error') {
        this.postMessage({
          type: 'error',
          message: `${outcome.message ?? 'The model request failed.'}\nWorkspace unchanged (0 files modified).`,
        });
      } else {
        this.postMessage({ type: 'turnDone', status: outcome.status });
      }
    } catch (err: any) {
      this.postMessage({ type: 'error', message: err.message });
    }
  }

  private async _handleCancel() {
    if (this.currentSessionId) {
      await this.client.cancelSession(this.currentSessionId);
      // Clean up staged unapplied proposals
      globalEditStaging.clearAll();
      this.postMessage({ type: 'turnDone', status: 'cancelled' });
    }
  }

  private async _handleProposalDecision(
    proposalId: string,
    decision: 'allow' | 'deny',
    toolCallId?: string
  ) {
    const proposal = globalEditStaging.getProposal(proposalId);
    const resolvedToolCallId = toolCallId ?? proposal?.toolCallId;

    if (decision === 'allow') {
      // Apply ONLY the hunks the user accepted (not a blanket accept-all)
      const result = globalEditStaging.applyProposal(proposalId);
      this.postMessage({
        type: 'proposalApplied',
        proposalId,
        appliedCount: result.appliedCount,
        totalCount: result.totalCount,
        filePath: result.filePath,
      });
    } else {
      globalEditStaging.discardProposal(proposalId);
      this.postMessage({ type: 'proposalApplied', proposalId, appliedCount: 0, totalCount: 0, filePath: proposal?.relativePath });
    }

    if (this.currentSessionId && resolvedToolCallId) {
      await this.client.resumeApproval(
        this.currentSessionId,
        resolvedToolCallId,
        decision,
        decision === 'deny' ? 'Rejected by user in ForgePilot diff review' : undefined
      );
    }
  }

  private async _openFile(relativePath: string, line?: number) {
    try {
      const fullPath = path.resolve(this.workspaceRoot, relativePath);
      const uri = vscode.Uri.file(fullPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (typeof line === 'number' && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err: any) {
      this.postMessage({ type: 'error', message: `Could not open ${relativePath}: ${err.message}` });
    }
  }

  private async _openDiff(proposalId: string) {
    const proposal = globalEditStaging.getProposal(proposalId);
    if (!proposal) {
      this.postMessage({ type: 'error', message: 'Proposal no longer available (already applied or discarded).' });
      return;
    }
    try {
      let originalUri: vscode.Uri;
      if (fs.existsSync(proposal.fullPath)) {
        originalUri = vscode.Uri.file(proposal.fullPath);
      } else {
        // New file: diff against an empty untitled document
        originalUri = (await vscode.workspace.openTextDocument({ content: '', language: this._guessLanguage(proposal.relativePath) })).uri;
      }
      const proposedDoc = await vscode.workspace.openTextDocument({
        content: proposal.proposedContent,
        language: this._guessLanguage(proposal.relativePath),
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposedDoc.uri,
        `${proposal.relativePath} (current ↔ proposed)`
      );
    } catch (err: any) {
      this.postMessage({ type: 'error', message: `Could not open diff: ${err.message}` });
    }
  }

  private _guessLanguage(relativePath: string): string {
    const ext = path.extname(relativePath).slice(1).toLowerCase();
    const map: Record<string, string> = {
      py: 'python', ts: 'typescript', tsx: 'typescriptreact', js: 'javascript',
      jsx: 'javascriptreact', json: 'json', md: 'markdown', rst: 'restructuredtext',
      css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sh: 'shellscript',
    };
    return map[ext] ?? ext ?? 'plaintext';
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview', 'style.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );

    html = html.replace('style.css', styleUri.toString());
    html = html.replace('webview.js', scriptUri.toString());

    return html;
  }
}

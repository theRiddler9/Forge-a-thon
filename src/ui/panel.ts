import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { globalEditStaging } from '../edit/staging.js';
import { applyProposalViaEditor } from '../edit/apply.js';
import { parseMentions, resolveMentions, formatContextBlock } from '../context/mentions.js';
import { globalContextBudget } from '../mcp/tools/contextBudget.js';
import { AGENT_INSTRUCTIONS } from '../agent/instructions.js';

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
  private sessionTokens = 0;
  private modelContexts = new Map<string, number>();

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
          this.sessionTokens = 0;
          this.postMessage({
            type: 'status',
            model: data.model,
          });
          this.postMessage({ type: 'session', label: 'Fresh Session' });
          this._postContextUsage();
          break;
        case 'resetSession':
          this.currentSessionId = undefined;
          this.sessionTokens = 0;
          globalEditStaging.clearAll();
          globalContextBudget.reset();
          this._refreshBudget();
          this.postMessage({ type: 'session', label: 'Fresh Session' });
          this.postMessage({ type: 'status', model: this.client.getActiveModel() });
          this._postContextUsage();
          break;
        case 'pickFileMention':
          await this._pickFileMention();
          break;
        case 'pickSymbolMention':
          await this._pickSymbolMention();
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
    const models = await this.client.listModelsDetailed();
    this.modelContexts = new Map(
      models.map((m) => [m.name, m.contextLength ?? 32768] as [string, number])
    );
    this.postMessage({
      type: 'modelsList',
      models: models.map((m) => m.name),
      contexts: Object.fromEntries(models.map((m) => [m.name, m.contextLength ?? 32768])),
      activeModel: this.client.getActiveModel(),
    });
    this.postMessage({
      type: 'status',
      model: this.client.getActiveModel(),
    });
    this._refreshBudget();
    this._postContextUsage();
  }

  private _postContextUsage() {
    const total = this.modelContexts.get(this.client.getActiveModel()) ?? 32768;
    this.postMessage({
      type: 'budgetUpdate',
      used: this.sessionTokens,
      total,
      scope: 'session',
    });
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
      // The context budget is per-turn: reset so a long session cannot
      // permanently exhaust it.
      globalContextBudget.reset();
      const INSTRUCTIONS = AGENT_INSTRUCTIONS;

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
          onReasoningDelta: (text: string) => {
            this.postMessage({ type: 'reasoningDelta', text });
          },
          onToolApprovalRequired: (toolCallId: string, toolName: string, args: any) => {
            if (toolName.includes('propose_write')) {
              const proposal = globalEditStaging.stageProposal(
                this.workspaceRoot,
                args.path ?? args.filePath ?? '',
                args.newContent ?? args.new_content ?? '',
                toolCallId,
                args.edits,
                args.rationale ?? args.rationaleText
              );
              this.postMessage({
                type: 'proposalReview',
                proposalId: proposal.proposalId,
                toolCallId,
                filePath: proposal.relativePath,
                hunks: proposal.hunks,
                rationale: proposal.rationale,
              });
              return;
            }

            this.postMessage({
              type: 'toolCall',
              id: toolCallId,
              name: toolName,
              args,
              isDestructive: true,
            });
          },
          onError: (err: Error) => {
            this.postMessage({ type: 'error', message: err.message });
          },
        };
      };

      let outcome = await this.client.runTurn(this.currentSessionId!, fullPrompt, makeHandlers());

      // 3a. Handle rate limits (429) with automatic backoff retry
      if (outcome.status === 'error' && outcome.message && /429|rate\s*limit/i.test(outcome.message)) {
        const match = outcome.message.match(/try again in ([\d\.]+)s/i);
        const waitSec = match ? Math.min(Math.ceil(parseFloat(match[1])) + 2, 35) : 15;
        this.postMessage({
          type: 'tokenDelta',
          text: `\n\n⏳ *Rate limit encountered. Auto-retrying with backoff in ${waitSec}s...*\n`,
        });
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        outcome = await this.client.runTurn(this.currentSessionId!, fullPrompt, makeHandlers());
      }

      // 3b. Automatic fallback: the configured primary model failed mid-turn.
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
      this.sessionTokens += outcome.metrics?.inputTokens ?? 0;
      this._postContextUsage();
      if (outcome.status === 'error') {
        const rawMsg = outcome.message ?? 'The model request failed.';
        let userFriendlyNotice = '';
        if (/429|rate\s*limit/i.test(rawMsg)) {
          userFriendlyNotice = '\n\n💡 Tip: Upstream rate limit reached. Please wait ~30 seconds for quota replenishment and try again, or configure a higher-quota model in TrueForge Settings.';
        } else if (/connect|econnrefused|network|timeout/i.test(rawMsg)) {
          userFriendlyNotice = '\n\n💡 Tip: Temporary network or server connectivity issue. Please verify TrueForge is running and try again.';
        } else {
          userFriendlyNotice = '\n\n💡 Tip: The upstream AI model failed to complete the turn. Please try again shortly.';
        }

        this.postMessage({
          type: 'error',
          message: `${rawMsg}${userFriendlyNotice}\n\nWorkspace unchanged (0 files modified).`,
        });
      } else {
        this.postMessage({ type: 'turnDone', status: outcome.status });
      }
    } catch (err: any) {
      const msg = err.message ?? String(err);
      this.postMessage({
        type: 'error',
        message: `${msg}\n\n💡 Tip: AI agent turn interrupted due to server connectivity or model limits. Workspace unchanged (0 files modified).`,
      });
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
    const realId = proposal?.proposalId ?? proposalId;
    const resolvedToolCallId = toolCallId ?? proposal?.toolCallId;

    if (globalEditStaging.isFinalized(realId) || globalEditStaging.isFinalized(proposalId)) {
      const fin =
        globalEditStaging.getFinalizedRecord(realId) ??
        globalEditStaging.getFinalizedRecord(proposalId);
      this.postMessage({
        type: 'proposalApplied',
        proposalId,
        appliedCount: fin?.appliedCount ?? 1,
        totalCount: fin?.totalCount ?? 1,
        filePath: fin?.relativePath ?? proposal?.relativePath,
      });
      return;
    }

    if (decision === 'allow') {
      // Apply ONLY the hunks the user accepted (not a blanket accept-all).
      // Every write flows through the editor (WorkspaceEdit + save).
      const result = await applyProposalViaEditor(realId);
      if (!result.ok) {
        if (!globalEditStaging.isFinalized(realId) && !globalEditStaging.isFinalized(proposalId)) {
          this.postMessage({
            type: 'error',
            message: `Could not apply the edits: ${result.reason}. No files were changed.`,
          });
        } else {
          const fin =
            globalEditStaging.getFinalizedRecord(realId) ??
            globalEditStaging.getFinalizedRecord(proposalId);
          this.postMessage({
            type: 'proposalApplied',
            proposalId,
            appliedCount: fin?.appliedCount ?? 1,
            totalCount: fin?.totalCount ?? 1,
            filePath: fin?.relativePath ?? proposal?.relativePath,
          });
        }
      } else {
        this.postMessage({
          type: 'proposalApplied',
          proposalId,
          appliedCount: result.appliedCount,
          totalCount: result.totalCount,
          filePath: result.relativePath,
        });
      }
    } else {
      globalEditStaging.discardProposal(realId);
      globalEditStaging.discardProposal(proposalId);
      this.postMessage({
        type: 'proposalApplied',
        proposalId,
        appliedCount: 0,
        totalCount: 0,
        filePath: proposal?.relativePath,
      });
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

  private async _pickFileMention() {
    const exclude =
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.pytest_cache/**,**/*.{png,jpg,jpeg,gif,ico,webp,svg,woff,woff2,ttf,eot,map,lock,vsix,egg-info}}';
    try {
      const uris = await vscode.workspace.findFiles('**/*', exclude, 1000);
      if (uris.length === 0) {
        vscode.window.showInformationMessage('ForgePilot: No attachable files found in this workspace.');
        return;
      }
      const items = uris
        .map((f) => {
          const rel = vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/');
          return {
            label: rel.split('/').pop() ?? rel,
            description: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
            rel,
          };
        })
        .sort((a, b) => a.rel.localeCompare(b.rel));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Attach @file — pick a file (${items.length}${uris.length >= 1000 ? '+' : ''} shown, type to filter)`,
        matchOnDescription: true,
      });
      if (pick) {
        this.postMessage({ type: 'insertMention', mention: `@file:${pick.rel}` });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`ForgePilot: Could not list workspace files: ${err.message}`);
    }
  }

  private async _pickSymbolMention() {
    try {
      let symbols =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          ''
        )) ?? [];
      if (symbols.length === 0) {
        const q = await vscode.window.showInputBox({
          prompt: 'Symbol name to attach (e.g. get_debug_flag)',
          placeHolder: 'workspace symbol…',
        });
        if (!q) return;
        symbols =
          (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            q
          )) ?? [];
        if (symbols.length === 0) {
          vscode.window.showInformationMessage(`ForgePilot: No symbols matching "${q}".`);
          return;
        }
      }
      const items = symbols
        .slice(0, 500)
        .map((s) => {
          const rel = s.location?.uri
            ? vscode.workspace.asRelativePath(s.location.uri, false).replace(/\\/g, '/')
            : '';
          const line = s.location?.range?.start?.line != null ? s.location.range.start.line + 1 : 0;
          return {
            label: s.name,
            description: vscode.SymbolKind[s.kind] ?? String(s.kind),
            detail: `${rel}${line ? `:${line}` : ''}`,
            sym: s,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Attach @symbol — pick a symbol (${items.length} shown, type to filter)`,
        matchOnDetail: true,
      });
      if (pick) {
        const name = pick.sym.name.replace(/\s+/g, '');
        this.postMessage({ type: 'insertMention', mention: `@symbol:${name}` });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`ForgePilot: Could not list workspace symbols: ${err.message}`);
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

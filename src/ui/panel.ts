import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { globalEditStaging } from '../edit/staging.js';
import { parseMentions, resolveMentions, formatContextBlock } from '../context/mentions.js';

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
          await this._handleProposalDecision(data.proposalId, data.decision);
          break;
      }
    });

    this.postMessage({
      type: 'status',
      model: this.client.getActiveModel(),
    });
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  private async _handleUserMessage(userInput: string) {
    try {
      // 1. Resolve mentions
      const parsed = parseMentions(userInput);
      const resolvedContext = await resolveMentions(this.workspaceRoot, parsed);
      const contextBlock = formatContextBlock(resolvedContext);

      if (contextBlock) {
        this.postMessage({
          type: 'contextChosen',
          text: contextBlock,
        });
      }

      const fullPrompt = contextBlock ? `${contextBlock}\n${userInput}` : userInput;

      // 2. Ensure session exists
      if (!this.currentSessionId) {
        const session = await this.client.createSessionWithFallback(
          'You are ForgePilot, an expert coding assistant. Before proposing file edits, summarize the chosen context and explain why each file was selected. Always use propose_write for file edits.'
        );
        this.currentSessionId = session.id;
        this.postMessage({
          type: 'status',
          model: this.client.getActiveModel(),
        });
      }

      // 3. Stream turn
      await this.client.streamTurn(this.currentSessionId, fullPrompt, {
        onDelta: (text) => {
          this.postMessage({ type: 'tokenDelta', text });
        },
        onToolApprovalRequired: (toolCallId, toolName, args) => {
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
              args.newContent
            );
            this.postMessage({
              type: 'proposalReview',
              proposalId: proposal.proposalId,
              filePath: proposal.relativePath,
              hunks: proposal.hunks,
            });
          }
        },
        onDone: (status) => {
          this.postMessage({ type: 'turnDone', status });
        },
        onError: (err) => {
          this.postMessage({ type: 'error', message: err.message });
        },
      });
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

  private async _handleProposalDecision(proposalId: string, decision: 'allow' | 'deny') {
    const proposal = globalEditStaging.getProposal(proposalId);
    if (!proposal) return;

    if (decision === 'allow') {
      globalEditStaging.acceptAllHunks(proposalId);
      globalEditStaging.applyProposal(proposalId);
    } else {
      globalEditStaging.discardProposal(proposalId);
    }

    if (this.currentSessionId) {
      await this.client.resumeApproval(this.currentSessionId, proposalId, decision);
    }
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

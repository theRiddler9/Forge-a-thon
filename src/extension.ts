import * as vscode from 'vscode';
import { startMcpServer } from './mcp/server.js';
import { McpServerInstance } from './mcp/types.js';
import { TrueForgeClient } from './trueforge/client.js';
import { AgentViewProvider } from './ui/panel.js';
import { registerInlineEditCommand } from './commands/inlineEdit.js';
import { registerUndoCommand } from './commands/undo.js';
import { globalEditStaging } from './edit/staging.js';
import { applyProposalViaEditor } from './edit/apply.js';
import { globalHunkCodeLensProvider } from './edit/codelens.js';
import { globalContextBudget } from './mcp/tools/contextBudget.js';

let mcpInstance: McpServerInstance | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const config = vscode.workspace.getConfiguration('forgepilot');
  const serverUrl = config.get<string>('serverUrl', 'http://localhost:8790');
  const primaryModel = config.get<string>('primaryModel', 'google-gemini/gemini-3-1-flash-lite');
  const fallbackModel = config.get<string>('fallbackModel', 'groq/qwen-3-8-27b');
  const tokenBudget = config.get<number>('tokenBudget', 30000);

  globalContextBudget.setBudget(tokenBudget);

  // 1. Start in-process MCP server (prefer stable port 8795, fallback to 0)
  try {
    mcpInstance = await startMcpServer({
      workspaceRoot,
      port: 8795,
    }).catch(async () => {
      return startMcpServer({ workspaceRoot, port: 0 });
    });
    console.log(`ForgePilot MCP server running at ${mcpInstance.url}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to start ForgePilot MCP server: ${err.message}`);
    return;
  }

  // 2. Initialize TrueForgeClient
  const client = new TrueForgeClient({
    baseUrl: serverUrl,
    primaryModel,
    fallbackModel,
    mcpServerName: 'forgepilot',
    mcpServerUrl: mcpInstance.url,
  });

  // Query live TrueForge models
  client.listAvailableModels().catch(() => {});

  // 3. Register MCP server in TrueForge Settings
  client.registerMcpServer('forgepilot', mcpInstance.url).then((registered) => {
    if (registered) {
      console.log('ForgePilot MCP server registered in TrueForge.');
    }
  });

  // 4. Register Agent View in Sidebar
  const agentProvider = new AgentViewProvider(context.extensionUri, client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, agentProvider)
  );

  // 5. Register Commands
  registerInlineEditCommand(context, client, workspaceRoot);
  registerUndoCommand(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'forgepilot.acceptHunk',
      async (proposalId: string, hunkId: string) => {
        globalEditStaging.setHunkDecision(proposalId, hunkId, 'accepted');
        const proposal = globalEditStaging.getProposal(proposalId);
        if (proposal && proposal.acceptedHunkIds.size + proposal.rejectedHunkIds.size === proposal.hunks.length) {
          const applied = await applyProposalViaEditor(proposalId);
          if (applied.ok) {
            vscode.window.showInformationMessage(`Applied accepted hunks to ${proposal.relativePath}.`);
            if (proposal.toolCallId) {
              try {
                const sessions = await (client as any).sdkClient?.sessions?.list?.();
                const latestSessionId = sessions?.data?.[0]?.id;
                if (latestSessionId) {
                  await client.resumeApproval(latestSessionId, proposal.toolCallId, 'allow');
                }
              } catch {}
            }
          } else {
            vscode.window.showErrorMessage(`ForgePilot: Could not apply the edits: ${applied.reason}. No files were changed.`);
          }
        }
        globalHunkCodeLensProvider.refresh();
      }
    ),
    vscode.commands.registerCommand(
      'forgepilot.rejectHunk',
      async (proposalId: string, hunkId: string) => {
        globalEditStaging.setHunkDecision(proposalId, hunkId, 'rejected');
        const proposal = globalEditStaging.getProposal(proposalId);
        if (proposal && proposal.acceptedHunkIds.size + proposal.rejectedHunkIds.size === proposal.hunks.length) {
          await applyProposalViaEditor(proposalId);
          if (proposal.toolCallId) {
            try {
              const sessions = await (client as any).sdkClient?.sessions?.list?.();
              const latestSessionId = sessions?.data?.[0]?.id;
              if (latestSessionId) {
                await client.resumeApproval(latestSessionId, proposal.toolCallId, 'deny', 'Rejected by user in diff review');
              }
            } catch {}
          }
        }
        globalHunkCodeLensProvider.refresh();
      }
    )
  );

  // 6. Register CodeLens Provider for in-editor hunk review
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, globalHunkCodeLensProvider)
  );

  vscode.window.showInformationMessage('ForgePilot extension activated successfully!');
}

export async function deactivate() {
  if (mcpInstance) {
    await mcpInstance.close();
    mcpInstance = undefined;
  }
}

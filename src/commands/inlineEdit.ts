import * as vscode from 'vscode';
import path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { globalEditStaging } from '../edit/staging.js';
import { globalHunkCodeLensProvider } from '../edit/codelens.js';

export function registerInlineEditCommand(
  context: vscode.ExtensionContext,
  client: TrueForgeClient,
  workspaceRoot: string
) {
  const disposable = vscode.commands.registerCommand('forgepilot.inlineEdit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('ForgePilot: Open an editor to use inline edit.');
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    const instruction = await vscode.window.showInputBox({
      title: `ForgePilot Inline Edit (${filePath}:${startLine}-${endLine})`,
      prompt: 'Enter instructions for the selected code',
      placeHolder: 'e.g. Treat the values off and n as false as well, case-insensitively...',
    });

    if (!instruction) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ForgePilot: Generating inline edit...',
        cancellable: true,
      },
      async (_progress, token) => {
        try {
          const fullDocText = editor.document.getText();
          const inlinePrompt = [
            `File: ${filePath}`,
            `Lines: ${startLine}-${endLine}`,
            `Selected Code:\n\`\`\`\n${selectedText}\n\`\`\``,
            `Instruction: ${instruction}`,
            `CRITICAL: Edit only the selected code or function according to the instruction. Call propose_write once with the modified code or full file.`,
          ].join('\n\n');

          const INSTRUCTIONS =
            'You are an inline code editing agent. Respond strictly by calling propose_write once with the modified content.';
          const session = await client.createSessionWithFallback(INSTRUCTIONS);
          let activeSessionId = session.id;

          token.onCancellationRequested(async () => {
            await client.cancelSession(activeSessionId);
            globalEditStaging.clearAll();
            globalHunkCodeLensProvider.refresh();
          });

          const makeHandlers = () => ({
            onToolApprovalRequired: async (toolCallId: string, toolName: string, args: any) => {
              if (toolName !== 'propose_write') return;

              let fullNewContent = args.newContent ?? '';
              // If the model returned only the modified function or snippet, splice it into the full document
              if (
                fullDocText.includes(selectedText) &&
                !fullNewContent.includes(fullDocText.slice(0, 50)) &&
                fullNewContent.length < fullDocText.length * 0.8
              ) {
                const prefix = fullDocText.substring(0, editor.document.offsetAt(selection.start));
                const suffix = fullDocText.substring(editor.document.offsetAt(selection.end));
                fullNewContent = prefix + fullNewContent + suffix;
              }

              const proposal = globalEditStaging.stageProposal(
                workspaceRoot,
                args.path || filePath,
                fullNewContent,
                toolCallId
              );

              globalHunkCodeLensProvider.refresh();

              // Open side-by-side diff preview for immediate visual feedback
              try {
                const proposedDoc = await vscode.workspace.openTextDocument({
                  content: proposal.proposedContent,
                  language: editor.document.languageId,
                });
                await vscode.commands.executeCommand(
                  'vscode.diff',
                  editor.document.uri,
                  proposedDoc.uri,
                  `${filePath} (Current ↔ Proposed Inline Edit)`
                );
              } catch (diffErr: any) {
                console.warn('Could not open diff view:', diffErr);
              }

              // Show action buttons to user
              const choice = await vscode.window.showInformationMessage(
                `ForgePilot proposed ${proposal.hunks.length} hunk(s) for ${filePath}.`,
                'Accept All',
                'Reject All'
              );

              if (choice === 'Accept All') {
                globalEditStaging.acceptAllHunks(proposal.proposalId);
                globalEditStaging.applyProposal(proposal.proposalId);
                await client.resumeApproval(activeSessionId, toolCallId, 'allow');
                vscode.window.showInformationMessage(`Applied all hunks to ${filePath}.`);
              } else if (choice === 'Reject All') {
                globalEditStaging.discardProposal(proposal.proposalId);
                await client.resumeApproval(activeSessionId, toolCallId, 'deny', 'User rejected proposal');
              }

              globalHunkCodeLensProvider.refresh();
            },
          });

          let outcome = await client.runTurn(activeSessionId, inlinePrompt, makeHandlers());

          // Automatic fallback: the configured primary model failed mid-turn.
          // Replay the identical instruction on the fallback model.
          if (outcome.status === 'error' && client.hasFallback()) {
            const to = client.getFallbackModel()!;
            vscode.window.showWarningMessage(
              `ForgePilot: primary model failed (${outcome.message ?? 'unknown error'}) — switching to fallback model ${to}`
            );
            try {
              const fbSession = await client.createSession(to, INSTRUCTIONS);
              client.markFallbackActivated();
              activeSessionId = fbSession.id;
              outcome = await client.runTurn(activeSessionId, inlinePrompt, makeHandlers());
            } catch (err: any) {
              outcome = { status: 'error', message: err?.message ?? String(err) };
            }
          }

          if (outcome.status === 'error') {
            vscode.window.showErrorMessage(
              `Inline edit failed: ${outcome.message ?? 'model request failed'}. Workspace unchanged (0 files modified).`
            );
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Inline edit failed: ${err.message}`);
        }
      }
    );
  });

  context.subscriptions.push(disposable);
}

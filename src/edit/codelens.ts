import * as vscode from 'vscode';
import { globalEditStaging } from './staging.js';

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const proposals = globalEditStaging.getAllProposals();

    for (const prop of proposals) {
      if (document.uri.fsPath === prop.fullPath) {
        for (const hunk of prop.hunks) {
          if (hunk.state === 'pending') {
            const line = Math.max(0, hunk.oldStart - 1);
            const range = new vscode.Range(line, 0, line, 0);

            lenses.push(
              new vscode.CodeLens(range, {
                title: '✓ Accept Hunk',
                command: 'forgepilot.acceptHunk',
                arguments: [prop.proposalId, hunk.id],
              }),
              new vscode.CodeLens(range, {
                title: '✗ Reject Hunk',
                command: 'forgepilot.rejectHunk',
                arguments: [prop.proposalId, hunk.id],
              })
            );
          }
        }
      }
    }

    return lenses;
  }
}

export const globalHunkCodeLensProvider = new HunkCodeLensProvider();

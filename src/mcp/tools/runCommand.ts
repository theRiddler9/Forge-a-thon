import { exec } from 'child_process';

export interface RunCommandArgs {
  command: string;
  timeoutMs?: number;
}

export const MAX_CMD_OUTPUT_LENGTH = 10000;

export async function executeRunCommand(
  workspaceRoot: string,
  args: RunCommandArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const command = args.command;
  const timeout = args.timeoutMs ?? 30000;

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: workspaceRoot,
        timeout,
        maxBuffer: 1024 * 1024 * 2,
      },
      (error, stdout, stderr) => {
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += `\nSTDERR:\n${stderr}`;
        if (error) output += `\nExit code: ${error.code ?? 1} (${error.message})`;

        if (output.length > MAX_CMD_OUTPUT_LENGTH) {
          output =
            output.slice(0, MAX_CMD_OUTPUT_LENGTH) +
            `\n[... Truncated ${output.length - MAX_CMD_OUTPUT_LENGTH} characters ...]`;
        }

        resolve({
          content: [{ type: 'text', text: output || '(command produced no output)' }],
        });
      }
    );
  });
}

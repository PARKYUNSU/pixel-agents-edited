import * as vscode from 'vscode';

import type { AgentProviderKind } from './agentLaunchSettings.js';

type AgentPick = vscode.QuickPickItem & {
  provider: AgentProviderKind;
  /** Claude only: use dangerously-skip-permissions */
  skipPermissions?: boolean;
};

/**
 * When the webview does not send `provider` (cached old UI or external caller),
 * ask in the extension host which CLI to spawn.
 */
export async function pickAgentProviderIfMissing(): Promise<{
  provider: AgentProviderKind;
  bypassPermissions: boolean | undefined;
} | null> {
  const items: AgentPick[] = [
    {
      label: 'Claude Code',
      description: 'JSONL + hooks (full Pixel Agents)',
      provider: 'claude',
    },
    {
      label: 'Claude Code — skip permissions',
      description: '⚠ bypasses tool approvals',
      provider: 'claude',
      skipPermissions: true,
    },
    {
      label: 'Gemini',
      description: 'Gemini CLI (keys from pixelAgents.envFilePath)',
      provider: 'gemini',
    },
    {
      label: 'Ollama',
      description: 'ollama run (OLLAMA_HOST / model from settings or .env)',
      provider: 'ollama',
    },
  ];

  const picked = await vscode.window.showQuickPick<AgentPick>(items, {
    title: 'Pixel Agents: agent provider',
    placeHolder: 'Choose which terminal to open',
  });

  if (!picked) return null;

  return {
    provider: picked.provider,
    bypassPermissions:
      picked.provider === 'claude' && picked.skipPermissions ? true : undefined,
  };
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  GLOBAL_KEY_GEMINI_KEY_ROTATION,
  TERMINAL_NAME_PREFIX,
  TERMINAL_NAME_PREFIX_GEMINI,
  TERMINAL_NAME_PREFIX_OLLAMA,
} from './constants.js';

export type AgentProviderKind = 'claude' | 'gemini' | 'ollama';

export interface AgentLaunchProfile {
  kind: AgentProviderKind;
  /** Claude only */
  bypassPermissions?: boolean;
  geminiApiKey?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  geminiModel?: string;
  geminiLaunchCommand?: string;
}

export function terminalPrefixFor(kind: AgentProviderKind): string {
  switch (kind) {
    case 'gemini':
      return TERMINAL_NAME_PREFIX_GEMINI;
    case 'ollama':
      return TERMINAL_NAME_PREFIX_OLLAMA;
    default:
      return TERMINAL_NAME_PREFIX;
  }
}

/** Safe single-quoted string for POSIX shells (macOS/Linux). */
export function shellQuotePosix(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnvFile(envPath: string): Record<string, string> {
  const abs = path.resolve(envPath);
  if (!fs.existsSync(abs)) return {};
  try {
    return parseDotEnv(fs.readFileSync(abs, 'utf8'));
  } catch {
    return {};
  }
}

/** Collects GEMINI_API_KEY and GEMINI_API_KEY_2 … _20 in order. */
export function collectGeminiKeys(env: Record<string, string>): string[] {
  const keys: string[] = [];
  const k0 = env.GEMINI_API_KEY?.trim();
  if (k0) keys.push(k0);
  for (let i = 2; i <= 20; i++) {
    const k = env[`GEMINI_API_KEY_${i}`]?.trim();
    if (k) keys.push(k);
  }
  return keys;
}

/**
 * Resolves which CLI + env to use for + Agent. Returns null when configuration
 * blocks launch (e.g. Gemini selected but no keys found).
 *
 * @param kindOverride — When set (from the webview picker), overrides `pixelAgents.agentProvider`.
 */
export async function resolveAgentLaunchProfile(
  context: vscode.ExtensionContext,
  bypassPermissions: boolean | undefined,
  kindOverride?: AgentProviderKind,
): Promise<AgentLaunchProfile | null> {
  const conf = vscode.workspace.getConfiguration('pixelAgents');
  const raw = (conf.get<string>('agentProvider') ?? 'claude').trim();
  const fromConfig: AgentProviderKind =
    raw === 'gemini' || raw === 'ollama' || raw === 'claude' ? raw : 'claude';
  const kind = kindOverride ?? fromConfig;
  if (kind === 'claude') {
    return { kind: 'claude', bypassPermissions };
  }

  const envFilePath = (conf.get<string>('envFilePath') ?? '').trim();
  const env = envFilePath ? loadEnvFile(envFilePath) : {};

  if (kind === 'gemini') {
    const keys = collectGeminiKeys(env);
    if (keys.length === 0) {
      await vscode.window.showErrorMessage(
        'Pixel Agents: No GEMINI_API_KEY entries found. Set pixelAgents.envFilePath to a .env file that lists your keys.',
      );
      return null;
    }
    let idx = context.globalState.get<number>(GLOBAL_KEY_GEMINI_KEY_ROTATION, 0);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    idx = idx % keys.length;
    const key = keys[idx];
    await context.globalState.update(GLOBAL_KEY_GEMINI_KEY_ROTATION, (idx + 1) % keys.length);
    console.log(
      `[Pixel Agents] Gemini key rotation: using key ${idx + 1} of ${keys.length} (index ${idx})`,
    );
    return {
      kind: 'gemini',
      geminiApiKey: key,
      geminiModel: (conf.get<string>('geminiModel') ?? 'gemini-2.5-flash').trim() || 'gemini-2.5-flash',
      geminiLaunchCommand: (conf.get<string>('geminiLaunchCommand') ?? 'gemini').trim() || 'gemini',
      bypassPermissions,
    };
  }

  if (kind === 'ollama') {
    const hostOverride = (conf.get<string>('ollamaHost') ?? '').trim();
    const ollamaHost = hostOverride || env.OLLAMA_HOST?.trim() || '';
    const modelSetting = (conf.get<string>('ollamaModel') ?? '').trim();
    const ollamaModel =
      modelSetting || env.LOCAL_LLM_MODEL?.trim() || 'llama3';
    if (!ollamaHost) {
      await vscode.window.showWarningMessage(
        'Pixel Agents: OLLAMA_HOST is not set. Using http://127.0.0.1:11434. Set pixelAgents.ollamaHost or OLLAMA_HOST in your .env.',
      );
    }
    return {
      kind: 'ollama',
      ollamaHost: ollamaHost || 'http://127.0.0.1:11434',
      ollamaModel,
      bypassPermissions,
    };
  }

  return { kind: 'claude', bypassPermissions };
}

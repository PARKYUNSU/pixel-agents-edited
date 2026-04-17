/**
 * Provider abstraction for AI agent tools.
 *
 * Only HookProvider ships today (Claude Code). Transcript-polling and push-based
 * provider types will be added when a real second provider (Codex, Goose,
 * Discord, etc.) actually lands, derived from that provider's needs rather than
 * speculation.
 *
 * Transcript lines: `HookProvider.parseTranscriptLine` turns each JSONL line into
 * `AgentEvent[]` (token usage, team metadata, tool starts, user/tool_result blocks,
 * progress rows, turn boundaries, etc.). The VS Code extension applies those
 * events in order; hook POSTs still use `normalizeHookEvent` only.
 */

import type { TeamProvider } from './teamProvider.js';

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | { kind: 'toolStart'; toolId: string; toolName: string; input?: unknown }
  | { kind: 'toolEnd'; toolId: string }
  | { kind: 'turnEnd' }
  | { kind: 'userTurn' }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | { kind: 'subagentTurnEnd'; parentToolId: string }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | { kind: 'sessionStart'; source?: string }
  | { kind: 'sessionEnd'; reason?: string }
  // ── Transcript / JSONL (HookProvider.parseTranscriptLine only; never from hooks) ──
  | { kind: 'tokenUsage'; inputTokensDelta: number; outputTokensDelta: number }
  | { kind: 'teamMetadata'; teamName: string; agentName?: string }
  | { kind: 'textIdle' }
  /** Emitted once before the first toolStart for an assistant line that contains tool_use blocks. */
  | { kind: 'transcriptAssistantToolTurnStart' }
  | { kind: 'transcriptUserPrompt' }
  | { kind: 'transcriptToolResultBlock'; toolUseId: string; block: Record<string, unknown> }
  | { kind: 'transcriptBackgroundDone'; toolUseId: string }
  | { kind: 'jsonlProgress'; record: Record<string, unknown> }
  | { kind: 'jsonlTurnDuration' }
  | { kind: 'jsonlUnknownType'; recordType: string }
  | { kind: 'jsonlParseWarning'; detail?: string };

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /**
   * Parse one JSONL line from this CLI's transcript file into normalized events.
   * Empty or non-JSON lines should yield `[]`; malformed JSON may yield `[]` or
   * `jsonlParseWarning` depending on provider policy. The extension applies each
   * event in order via `applyTranscriptAgentEvent` (see `src/transcriptParser.ts`).
   */
  parseTranscriptLine?(line: string): AgentEvent[];
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider

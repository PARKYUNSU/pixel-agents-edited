/**
 * Claude Code JSONL transcript line → normalized AgentEvent[].
 * Mirrors field names and structure used by Claude's session `.jsonl` files.
 */

import type { AgentEvent } from '../../../provider.js';

/** Record types we never surface as jsonlUnknownType (handled elsewhere or intentionally ignored). */
const KNOWN_SILENT_RECORD_TYPES = new Set(['file-history-snapshot', 'system', 'queue-operation']);

function extractTeamMetadataFromRecord(record: Record<string, unknown>): {
  teamName: string;
  agentName?: string;
} | null {
  const teamName = record.teamName;
  if (typeof teamName !== 'string') return null;
  const agentName = record.agentName;
  return {
    teamName,
    agentName: typeof agentName === 'string' ? agentName : undefined,
  };
}

/** True when a user-message `tool_result` block indicates a background/async agent launch. */
export function isAsyncAgentToolResultBlock(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}

/**
 * Parse a single JSONL line from a Claude session transcript into normalized events.
 * Order matches the previous monolithic parser: team + usage first, then type-specific events.
 */
export function parseClaudeJsonlTranscriptLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const events: AgentEvent[] = [];

  const teamMeta = extractTeamMetadataFromRecord(record);
  if (teamMeta?.teamName) {
    events.push({
      kind: 'teamMetadata',
      teamName: teamMeta.teamName,
      agentName: teamMeta.agentName,
    });
  }

  const message = record.message as { usage?: unknown; content?: unknown } | undefined;
  const usage = message?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (usage) {
    let inputTokensDelta = 0;
    let outputTokensDelta = 0;
    if (typeof usage.input_tokens === 'number') inputTokensDelta += usage.input_tokens;
    if (typeof usage.output_tokens === 'number') outputTokensDelta += usage.output_tokens;
    if (inputTokensDelta !== 0 || outputTokensDelta !== 0) {
      events.push({
        kind: 'tokenUsage',
        inputTokensDelta,
        outputTokensDelta,
      });
    }
  }

  const t = record.type;
  if (t === 'assistant') {
    const assistantContent = message?.content ?? record.content;

    if (Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        events.push({ kind: 'transcriptAssistantToolTurnStart' });
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            events.push({
              kind: 'toolStart',
              toolId: block.id,
              toolName,
              input: block.input || {},
            });
          }
        }
      } else if (blocks.some((b) => b.type === 'text')) {
        events.push({ kind: 'textIdle' });
      }
    } else if (typeof assistantContent === 'string') {
      events.push({ kind: 'textIdle' });
    } else if (assistantContent === undefined) {
      events.push({
        kind: 'jsonlParseWarning',
        detail: `assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
      });
    }

    return events;
  }

  if (t === 'progress') {
    events.push({ kind: 'jsonlProgress', record });
    return events;
  }

  if (t === 'user') {
    const content = message?.content ?? record.content;
    if (Array.isArray(content)) {
      const blocks = content as Array<
        { type: string; tool_use_id?: string } & Record<string, unknown>
      >;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (hasToolResult) {
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            events.push({
              kind: 'transcriptToolResultBlock',
              toolUseId: block.tool_use_id,
              block,
            });
          }
        }
      } else {
        events.push({ kind: 'transcriptUserPrompt' });
      }
    } else if (typeof content === 'string' && content.trim()) {
      events.push({ kind: 'transcriptUserPrompt' });
    }
    return events;
  }

  if (t === 'queue-operation' && record.operation === 'enqueue') {
    const content = record.content as string | undefined;
    if (content) {
      const toolIdMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (toolIdMatch) {
        events.push({ kind: 'transcriptBackgroundDone', toolUseId: toolIdMatch[1] });
      }
    }
    return events;
  }

  if (t === 'system' && record.subtype === 'turn_duration') {
    events.push({ kind: 'jsonlTurnDuration' });
    return events;
  }

  if (typeof t === 'string' && !KNOWN_SILENT_RECORD_TYPES.has(t)) {
    events.push({ kind: 'jsonlUnknownType', recordType: t });
  }

  return events;
}

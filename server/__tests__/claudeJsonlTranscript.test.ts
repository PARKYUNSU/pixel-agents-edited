import { describe, expect, it } from 'vitest';

import {
  isAsyncAgentToolResultBlock,
  parseClaudeJsonlTranscriptLine,
} from '../src/providers/hook/claude/claudeJsonlTranscript.js';

describe('parseClaudeJsonlTranscriptLine', () => {
  it('returns no events for a blank line', () => {
    expect(parseClaudeJsonlTranscriptLine('')).toEqual([]);
    expect(parseClaudeJsonlTranscriptLine('   \n')).toEqual([]);
  });

  it('parses assistant tool_use into turn start + toolStart events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Grep', input: {} },
        ],
      },
    });
    const events = parseClaudeJsonlTranscriptLine(line);
    expect(events.map((e) => e.kind)).toEqual([
      'transcriptAssistantToolTurnStart',
      'toolStart',
      'toolStart',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'toolStart',
      toolId: 'toolu_1',
      toolName: 'Read',
    });
  });

  it('emits textIdle for assistant text-only array content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(parseClaudeJsonlTranscriptLine(line)).toEqual([{ kind: 'textIdle' }]);
  });

  it('emits transcriptToolResultBlock for user tool_result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tid-1',
            content: 'done',
          },
        ],
      },
    });
    const events = parseClaudeJsonlTranscriptLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'transcriptToolResultBlock',
      toolUseId: 'tid-1',
    });
  });
});

describe('isAsyncAgentToolResultBlock', () => {
  it('detects async launch from string content', () => {
    expect(
      isAsyncAgentToolResultBlock({
        type: 'tool_result',
        tool_use_id: 'x',
        content: 'Async agent launched successfully.',
      }),
    ).toBe(true);
    expect(
      isAsyncAgentToolResultBlock({
        type: 'tool_result',
        tool_use_id: 'x',
        content: 'other',
      }),
    ).toBe(false);
  });

  it('detects async launch from structured content array', () => {
    expect(
      isAsyncAgentToolResultBlock({
        type: 'tool_result',
        tool_use_id: 'x',
        content: [{ type: 'text', text: 'Async agent launched successfully. Session foo' }],
      }),
    ).toBe(true);
  });
});

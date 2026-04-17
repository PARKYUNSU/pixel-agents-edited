import * as path from 'path';
import type * as vscode from 'vscode';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from '../server/src/constants.js';
import type { AgentEvent, HookProvider } from '../server/src/provider.js';
import { isAsyncAgentToolResultBlock } from '../server/src/providers/hook/claude/claudeJsonlTranscript.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

/** Hook provider: supplies formatToolStatus + team.extractTeamMetadataFromRecord.
 *  Registered once at startup via setHookProvider(). Functions below assume it's set. */
let hookProvider: HookProvider | null = null;

/** Register the HookProvider that owns CLI-specific formatting and team metadata extraction. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/** Format a tool status line. Delegates to the active HookProvider's formatToolStatus. */
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  if (hookProvider) return hookProvider.formatToolStatus(toolName, input);
  // Fallback for bootstrapping / tests without a provider set.
  return defaultFormatToolStatus(toolName, input);
}

/** Fallback formatter for edge cases (tests, provider not yet registered).
 *  Mirrors Claude's formatting; most code paths use the provider's implementation. */
function defaultFormatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return `Editing notebook`;
    case 'TeamCreate': {
      const teamName = typeof input.team_name === 'string' ? input.team_name : '';
      return teamName ? `Creating team: ${teamName}` : 'Creating team';
    }
    case 'SendMessage': {
      const recipient = typeof input.recipient === 'string' ? input.recipient : '';
      return recipient ? `-> ${recipient}` : 'Sending message';
    }
    default:
      return `Using ${toolName}`;
  }
}

function permissionExemptTools(): ReadonlySet<string> {
  return hookProvider?.permissionExemptTools ?? PERMISSION_EXEMPT_TOOLS;
}

/**
 * Apply one normalized transcript event from HookProvider.parseTranscriptLine.
 * Preserves prior JSONL behavior: webview messages, timers, and permission heuristics.
 */
export function applyTranscriptAgentEvent(
  agentId: number,
  event: AgentEvent,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const exempt = permissionExemptTools();

  switch (event.kind) {
    case 'teamMetadata': {
      if (event.teamName && event.teamName !== agent.teamName) {
        agent.teamName = event.teamName;
        agent.agentName = event.agentName;
        agent.isTeamLead = undefined;
        agent.leadAgentId = undefined;
        if (debug) {
          console.log(
            `[Pixel Agents] Agent ${agentId} team metadata: team=${agent.teamName}, role=${agent.agentName ?? 'lead'}`,
          );
        }
        linkTeammates(agentId, agent, agents);

        webview?.postMessage({
          type: 'agentTeamInfo',
          id: agentId,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
        });
      }
      break;
    }

    case 'tokenUsage': {
      if (event.inputTokensDelta !== 0) {
        agent.inputTokens += event.inputTokensDelta;
      }
      if (event.outputTokensDelta !== 0) {
        agent.outputTokens += event.outputTokensDelta;
      }
      webview?.postMessage({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
      break;
    }

    case 'transcriptAssistantToolTurnStart': {
      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
      break;
    }

    case 'toolStart': {
      const toolName = event.toolName || '';
      const status = formatToolStatus(toolName, (event.input || {}) as Record<string, unknown>);
      const blockInput = (event.input || {}) as Record<string, unknown>;
      console.log(`[Pixel Agents] JSONL: Agent ${agentId} - tool start: ${event.toolId} ${status}`);

      agent.activeToolIds.add(event.toolId);
      agent.activeToolStatuses.set(event.toolId, status);
      agent.activeToolNames.set(event.toolId, toolName);

      let hasNonExemptTool = false;
      if (!exempt.has(toolName)) {
        hasNonExemptTool = true;
      }

      if (
        agent.teamName &&
        toolName === 'Agent' &&
        blockInput.run_in_background === true &&
        !agent.teamUsesTmux
      ) {
        agent.teamUsesTmux = true;
        webview?.postMessage({
          type: 'agentTeamInfo',
          id: agentId,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: true,
        });
      }

      const isSubagentSpawn = toolName === 'Agent' || toolName === 'Task';
      if (!agent.hookDelivered || isSubagentSpawn) {
        const runInBackground = isSubagentSpawn && blockInput.run_in_background === true;
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: event.toolId,
          status,
          toolName,
          permissionActive: agent.permissionSent,
          runInBackground,
        });
      }

      if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
        startPermissionTimer(agentId, agents, permissionTimers, exempt, webview);
      }
      break;
    }

    case 'textIdle': {
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
      }
      break;
    }

    case 'transcriptUserPrompt': {
      cancelWaitingTimer(agentId, waitingTimers);
      clearAgentActivity(agent, agentId, permissionTimers, webview);
      agent.hadToolsInTurn = false;
      break;
    }

    case 'transcriptToolResultBlock': {
      const completedToolId = event.toolUseId;
      const block = event.block;
      const completedToolName = agent.activeToolNames.get(completedToolId);

      if (
        (completedToolName === 'Task' || completedToolName === 'Agent') &&
        isAsyncAgentToolResultBlock(block)
      ) {
        console.log(
          `[Pixel Agents] Agent ${agentId} background agent launched: ${completedToolId}`,
        );
        agent.backgroundAgentToolIds.add(completedToolId);
        break;
      }

      console.log(`[Pixel Agents] JSONL: Agent ${agentId} - tool done: ${completedToolId}`);

      if (completedToolName === 'Task' || completedToolName === 'Agent') {
        agent.activeSubagentToolIds.delete(completedToolId);
        agent.activeSubagentToolNames.delete(completedToolId);
        webview?.postMessage({
          type: 'subagentClear',
          id: agentId,
          parentToolId: completedToolId,
        });
      }
      agent.activeToolIds.delete(completedToolId);
      agent.activeToolStatuses.delete(completedToolId);
      agent.activeToolNames.delete(completedToolId);

      const isCompletedAgentTool = completedToolName === 'Task' || completedToolName === 'Agent';
      if (!agent.hookDelivered || isCompletedAgentTool) {
        const toolId = completedToolId;
        setTimeout(() => {
          webview?.postMessage({
            type: 'agentToolDone',
            id: agentId,
            toolId,
          });
        }, TOOL_DONE_DELAY_MS);
      }

      if (agent.activeToolIds.size === 0) {
        agent.hadToolsInTurn = false;
      }
      break;
    }

    case 'transcriptBackgroundDone': {
      const completedToolId = event.toolUseId;
      if (agent.backgroundAgentToolIds.has(completedToolId)) {
        console.log(`[Pixel Agents] Agent ${agentId} background agent done: ${completedToolId}`);
        agent.backgroundAgentToolIds.delete(completedToolId);
        agent.activeSubagentToolIds.delete(completedToolId);
        agent.activeSubagentToolNames.delete(completedToolId);
        webview?.postMessage({
          type: 'subagentClear',
          id: agentId,
          parentToolId: completedToolId,
        });
        agent.activeToolIds.delete(completedToolId);
        agent.activeToolStatuses.delete(completedToolId);
        agent.activeToolNames.delete(completedToolId);
        if (!agent.hookDelivered) {
          const toolId = completedToolId;
          setTimeout(() => {
            webview?.postMessage({
              type: 'agentToolDone',
              id: agentId,
              toolId,
            });
          }, TOOL_DONE_DELAY_MS);
        }
      }
      break;
    }

    case 'jsonlProgress': {
      processProgressRecord(
        agentId,
        event.record,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      );
      break;
    }

    case 'jsonlTurnDuration': {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
      if (hasForegroundTools) {
        for (const toolId of [...agent.activeToolIds]) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          agent.activeToolNames.delete(toolId);
          if (toolName === 'Task' || toolName === 'Agent') {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
          }
        }
        if (!agent.hookDelivered) {
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }
        for (const toolId of agent.backgroundAgentToolIds) {
          const status = agent.activeToolStatuses.get(toolId);
          if (status) {
            webview?.postMessage({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              status,
            });
          }
        }
      } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        if (!agent.hookDelivered) {
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      if (!agent.hookDelivered) {
        webview?.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
      }
      break;
    }

    case 'jsonlUnknownType': {
      if (!agent.seenUnknownRecordTypes.has(event.recordType)) {
        agent.seenUnknownRecordTypes.add(event.recordType);
        if (debug) {
          console.log(
            `[Pixel Agents] JSONL: Agent ${agentId} - unrecognized record type '${event.recordType}'.`,
          );
        }
      }
      break;
    }

    case 'jsonlParseWarning': {
      console.warn(`[Pixel Agents] Agent ${agentId}: ${event.detail ?? 'JSONL parse warning'}`);
      break;
    }

    default:
      return;
  }
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;

  const events = hookProvider?.parseTranscriptLine?.(line) ?? [];
  for (const event of events) {
    applyTranscriptAgentEvent(agentId, event, agents, waitingTimers, permissionTimers, webview);
  }
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered && !agent.leadAgentId) {
      startPermissionTimer(agentId, agents, permissionTimers, permissionExemptTools(), webview);
    }
    return;
  }

  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (parentToolName !== 'Task' && parentToolName !== 'Agent') return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      const b = block as {
        type?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      };
      if (b.type === 'tool_use' && b.id) {
        const toolName = b.name || '';
        const status = formatToolStatus(toolName, b.input || {});
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${b.id} ${status} (parent: ${parentToolId})`,
        );

        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(b.id);

        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(b.id, toolName);

        if (!permissionExemptTools().has(toolName)) {
          hasNonExemptSubTool = true;
        }

        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: b.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, permissionExemptTools(), webview);
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string };
      if (b.type === 'tool_result' && b.tool_use_id) {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${b.tool_use_id} (parent: ${parentToolId})`,
        );

        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(b.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(b.tool_use_id);
        }

        const toolId = b.tool_use_id;
        setTimeout(() => {
          webview?.postMessage({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, 300);
      }
    }
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!permissionExemptTools().has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, permissionExemptTools(), webview);
    }
  }
}

/**
 * Link teammates within the same team.
 * The lead is the agent with no agentName (or the first one detected in the team).
 * Teammates get leadAgentId pointing to the lead.
 */
function linkTeammates(_agentId: number, agent: AgentState, agents: Map<number, AgentState>): void {
  const teamName = agent.teamName;
  if (!teamName) return;

  const teamAgents: AgentState[] = [];
  for (const a of agents.values()) {
    if (a.teamName === teamName) {
      teamAgents.push(a);
    }
  }

  let lead: AgentState | undefined;
  for (const a of teamAgents) {
    if (!a.agentName) {
      lead = a;
      break;
    }
  }
  if (!lead) {
    for (const a of teamAgents) {
      if (a.isTeamLead) {
        lead = a;
        break;
      }
    }
  }
  if (!lead) {
    lead = teamAgents[0];
  }

  for (const a of teamAgents) {
    if (a.id === lead.id) {
      a.isTeamLead = true;
      a.leadAgentId = undefined;
    } else {
      a.isTeamLead = false;
      a.leadAgentId = lead.id;
    }
  }
}

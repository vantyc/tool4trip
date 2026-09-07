import { randomUUID } from 'node:crypto'
import {
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import {
  AgentRuntimeError,
  assertLlmReady,
  assertWebSearchReady,
  type LlmEnvConfig,
} from '../llm/config.ts'
import type { ChatMessage, LLMProvider } from '../llm/types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { buildUserMessage, registerTravelTools } from '../tools/travelTools.ts'
import { buildRepairPrompt, buildSystemPrompt } from './prompts.ts'

export type AgentRuntimeDeps = {
  llm: LLMProvider
  cfg: LlmEnvConfig
  /** Injected for tests — default builds registry with real tools. */
  createRegistry?: () => ToolRegistry
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim())
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('no JSON object in model output')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function normalizeGoals(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((g) => {
      if (typeof g === 'string') return g
      const o = asRecord(g)
      return str(o.label, str(o.id))
    })
    .filter(Boolean)
}

/** Fill server-owned fields; do not invent narrative or travel facts. */
function hydrateProposal(
  raw: unknown,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
): unknown {
  const obj = asRecord(raw)
  const trip = asRecord(req.context.trip)
  const tripId = str(trip.id, req.tripId)
  const title = str(trip.title, 'Viaje')
  const startDate = str(trip.startDate, '2026-01-01')
  const endDate = str(trip.endDate, startDate)
  const timezone = str(trip.timezone, 'America/Mexico_City')
  const packageImports = req.context.packageImports.map(asRecord)
  const priorPkg = packageImports[0]
  const packageId =
    str(priorPkg?.id) ||
    str(priorPkg?.packageId) ||
    `agent-${tripId}`
  const priorRevision =
    typeof priorPkg?.revision === 'number' ? priorPkg.revision : 0
  const revision = Math.max(1, priorRevision + 1)

  const pkg = asRecord(obj.package)
  const pkgTrip = asRecord(pkg.trip)

  // Preserve model narrative/warnings/diff/ops/package body; only stamp ids + toolTrace.
  return {
    ...obj,
    proposalId: str(obj.proposalId) || randomUUID(),
    createdAt: str(obj.createdAt) || nowIso(),
    toolTrace,
    package: {
      ...pkg,
      schemaVersion: 1,
      packageId: str(pkg.packageId, packageId),
      revision:
        typeof pkg.revision === 'number' && pkg.revision >= 1
          ? pkg.revision
          : revision,
      generatedAt: str(pkg.generatedAt) || nowIso(),
      trip: {
        ...pkgTrip,
        id: str(pkgTrip.id, tripId),
        title: str(pkgTrip.title, title),
        destination:
          str(pkgTrip.destination) || str(trip.destination) || undefined,
        startDate: str(pkgTrip.startDate, startDate),
        endDate: str(pkgTrip.endDate, endDate),
        timezone: str(pkgTrip.timezone, timezone),
        goals: normalizeGoals(
          Array.isArray(pkgTrip.goals) && pkgTrip.goals.length
            ? pkgTrip.goals
            : trip.goals,
        ),
        status: str(pkgTrip.status, str(trip.status, 'planned')),
        notes: str(pkgTrip.notes) || str(trip.notes) || undefined,
      },
      travelOptions: Array.isArray(pkg.travelOptions) ? pkg.travelOptions : [],
      itineraryItems: Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : [],
      checklistItems: Array.isArray(pkg.checklistItems) ? pkg.checklistItems : [],
      notes: Array.isArray(pkg.notes) ? pkg.notes : [],
    },
  }
}

function tryParseProposal(
  text: string,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
): { ok: true; proposal: AgentProposal } | { ok: false; error: string } {
  try {
    const raw = extractJsonObject(text)
    const hydrated = hydrateProposal(raw, req, toolTrace)
    const parsed = agentProposalSchema.safeParse(hydrated)
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message }
    }
    return { ok: true, proposal: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'parse failed',
    }
  }
}

/**
 * AgentRuntime: LLM tool-calling loop → Zod-validated AgentProposal.
 */
export async function runAgentAsk(
  req: AgentAskRequest,
  deps: AgentRuntimeDeps,
): Promise<AgentProposal> {
  assertLlmReady(deps.cfg)
  if (deps.cfg.enableWebTools) {
    assertWebSearchReady(deps.cfg)
  }

  const registry =
    deps.createRegistry?.() ??
    (() => {
      const r = new ToolRegistry()
      registerTravelTools(r, {
        enableWebTools: deps.cfg.enableWebTools,
        webSearchProvider: deps.cfg.webSearchProvider,
        enableDdgFallback: deps.cfg.enableDdgFallback,
      })
      return r
    })()

  const toolTrace: ToolTraceEntry[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.cfg.timeoutMs)

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(req) },
  ]

  let toolCallsUsed = 0
  let steps = 0

  try {
    while (steps < deps.cfg.maxSteps) {
      steps += 1
      if (controller.signal.aborted) {
        throw new AgentRuntimeError('Agent timeout', 'llm_timeout')
      }

      const tools = registry.definitions()
      const result = await deps.llm.chat({
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : 'none',
        signal: controller.signal,
      })

      const assistant = result.message
      messages.push(assistant)

      if (assistant.tool_calls?.length) {
        for (const call of assistant.tool_calls) {
          if (toolCallsUsed >= deps.cfg.maxToolCalls) {
            const checkedAt = nowIso()
            const skipTrace: ToolTraceEntry = {
              tool: call.function.name,
              args: { skipped: true },
              ok: false,
              sources: [],
              error: `AGENT_MAX_TOOL_CALLS=${deps.cfg.maxToolCalls} exceeded`,
              checkedAt,
            }
            toolTrace.push(skipTrace)
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify({
                UNTRUSTED_CONTENT: true,
                error: skipTrace.error,
              }),
            })
            continue
          }
          toolCallsUsed += 1
          const exec = await registry.execute(
            call.function.name,
            call.function.arguments,
            { signal: controller.signal },
          )
          toolTrace.push(exec.trace)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: exec.contentForModel,
          })
        }
        continue
      }

      const content = assistant.content?.trim() || ''
      if (!content) {
        throw new AgentRuntimeError(
          'LLM returned empty content without tool calls',
          'llm_empty',
        )
      }

      const first = tryParseProposal(content, req, toolTrace)
      if (first.ok) return first.proposal

      // Single repair turn — no tools
      const repair = await deps.llm.chat({
        messages: [
          ...messages,
          {
            role: 'user',
            content: buildRepairPrompt(first.error),
          },
        ],
        tool_choice: 'none',
        response_format: { type: 'json_object' },
        signal: controller.signal,
      })
      messages.push(repair.message)
      const repairedText = repair.message.content?.trim() || ''
      const second = tryParseProposal(repairedText, req, toolTrace)
      if (second.ok) return second.proposal

      throw new AgentRuntimeError(
        `AgentProposal JSON inválido tras repair: ${second.error}`,
        'invalid_proposal',
      )
    }

    throw new AgentRuntimeError(
      `AGENT_MAX_STEPS=${deps.cfg.maxSteps} exceeded`,
      'max_steps',
    )
  } catch (err) {
    if (err instanceof AgentRuntimeError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

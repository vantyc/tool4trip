import type { AgentAskRequest, AgentProposal } from '../../shared/agentContracts.ts'
import {
  AgentConfigError,
  AgentRuntimeError,
  type LlmEnvConfig,
} from '../llm/config.ts'
import type { AgentRunResult } from '../agent/runtime.ts'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { logJobEvent } from './log.ts'
import type { InMemoryJobStore, JobRecord } from './store.ts'

export type JobRunner = (req: AgentAskRequest, meta: {
  jobId: string
  requestId: string
}) => Promise<AgentRunResult | AgentProposal>

export type JobWorkerOptions = {
  store: InMemoryJobStore
  run: JobRunner
  cfg: Pick<LlmEnvConfig, 'provider' | 'model' | 'timeoutMs'>
}

/**
 * Single-process worker: drains queued jobs up to maxConcurrency.
 * Work is fully decoupled from the HTTP request that created the job.
 */
export class JobWorker {
  private readonly store: InMemoryJobStore
  private readonly run: JobRunner
  private readonly cfg: JobWorkerOptions['cfg']
  private pumping = false

  constructor(opts: JobWorkerOptions) {
    this.store = opts.store
    this.run = opts.run
    this.cfg = opts.cfg
  }

  /** Schedule a pump tick (idempotent). */
  kick(): void {
    if (this.pumping) return
    this.pumping = true
    queueMicrotask(() => {
      void this.pump().finally(() => {
        this.pumping = false
        if (this.store.queued > 0 && this.store.running < this.store.maxConcurrencyLimit) {
          this.kick()
        }
      })
    })
  }

  private async pump(): Promise<void> {
    for (;;) {
      const job = this.store.claimNext()
      if (!job) return
      void this.execute(job).then(() => this.kick())
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const t0 = Date.now()
    const request = job.request
    if (!request) {
      this.store.markFailed(job.jobId, {
        message: 'Job missing request payload',
        code: 'job_invalid',
      })
      logJobEvent('job_failed', {
        jobId: job.jobId,
        requestId: job.requestId,
        tripId: job.tripId,
        status: 'failed',
        durationMs: Date.now() - t0,
        provider: this.cfg.provider,
        model: this.cfg.model,
      })
      return
    }

    logJobEvent('job_status', {
      jobId: job.jobId,
      requestId: job.requestId,
      tripId: job.tripId,
      status: 'running',
      provider: this.cfg.provider,
      model: this.cfg.model,
    })

    try {
      const result = await this.run(request, {
        jobId: job.jobId,
        requestId: job.requestId,
      })
      const proposal =
        'proposal' in result && result.proposal
          ? result.proposal
          : (result as AgentProposal)
      const meta = 'meta' in result ? result.meta : undefined
      this.store.markSucceeded(job.jobId, proposal, {
        steps: meta?.steps,
        lastFinishReason: meta?.lastFinishReason,
        usage: meta?.usage,
      })
      logJobEvent('job_status', {
        jobId: job.jobId,
        requestId: job.requestId,
        tripId: job.tripId,
        status: 'succeeded',
        durationMs: Date.now() - t0,
        tool: proposal.toolTrace?.[0]?.tool ?? null,
        llmCalls: meta?.llmCalls ?? null,
        hadRepair: meta?.hadRepair ?? null,
        finalContentChars: meta?.finalContentChars ?? null,
        provider: this.cfg.provider,
        model: this.cfg.model,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'agent job failed'
      const code =
        err instanceof AgentConfigError
          ? err.code
          : err instanceof AgentRuntimeError
            ? err.code
            : 'agent_runtime'
      const runMeta =
        err instanceof AgentRuntimeError ? err.runMeta : undefined
      this.store.markFailed(
        job.jobId,
        { message, code },
        {
          toolTrace: runMeta?.toolTrace as ToolTraceEntry[] | undefined,
          steps: runMeta?.steps,
          lastFinishReason: runMeta?.lastFinishReason,
          usage: runMeta?.usage,
        },
      )
      logJobEvent('job_status', {
        jobId: job.jobId,
        requestId: job.requestId,
        tripId: job.tripId,
        status: 'failed',
        durationMs: Date.now() - t0,
        errorCode: code,
        llmCalls: runMeta?.llmCalls ?? null,
        lastFinishReason: runMeta?.lastFinishReason ?? null,
        provider: this.cfg.provider,
        model: this.cfg.model,
      })
    }
  }
}

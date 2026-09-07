import { randomUUID } from 'node:crypto'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'
import type { LlmEnvConfig } from '../llm/config.ts'
import { InMemoryJobStore } from './store.ts'
import { JobWorker, type JobRunner } from './worker.ts'
import { logJobEvent } from './log.ts'

export type JobSystemOptions = {
  cfg: LlmEnvConfig
  run: JobRunner
  ttlMs?: number
  maxJobs?: number
  maxConcurrency?: number
}

export type JobSystem = {
  store: InMemoryJobStore
  worker: JobWorker
  enqueue: (
    request: AgentAskRequest,
    meta?: { requestId?: string },
  ) => { jobId: string; status: 'queued'; requestId: string }
}

export function createJobSystem(opts: JobSystemOptions): JobSystem {
  const ttlMs = opts.ttlMs ?? positiveInt(process.env.AGENT_JOB_TTL_MS, 45 * 60_000)
  const maxJobs = opts.maxJobs ?? positiveInt(process.env.AGENT_JOB_MAX_JOBS, 50)
  const maxConcurrency =
    opts.maxConcurrency ?? positiveInt(process.env.AGENT_JOB_MAX_CONCURRENCY, 1)

  const store = new InMemoryJobStore({
    ttlMs,
    maxJobs,
    maxConcurrency,
  })
  const worker = new JobWorker({
    store,
    run: opts.run,
    cfg: opts.cfg,
  })

  return {
    store,
    worker,
    enqueue(request, meta = {}) {
      const requestId = meta.requestId ?? randomUUID()
      const job = store.create(request, { requestId })
      logJobEvent('job_status', {
        jobId: job.jobId,
        requestId,
        tripId: job.tripId,
        status: 'queued',
        provider: opts.cfg.provider,
        model: opts.cfg.model,
      })
      worker.kick()
      return { jobId: job.jobId, status: 'queued' as const, requestId }
    },
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

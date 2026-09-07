import { randomUUID } from 'node:crypto'
import type {
  AgentAskRequest,
  AgentJobStatus,
  AgentJobStatusResponse,
  AgentProposal,
  ToolTraceEntry,
} from '../../shared/agentContracts.ts'

export type JobError = { message: string; code?: string }

export type JobUsageTotals = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type JobRecord = {
  jobId: string
  requestId: string
  tripId: string
  status: AgentJobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  progress?: string
  /** Cleared when job reaches a terminal state. */
  request?: AgentAskRequest
  proposal?: AgentProposal
  error?: JobError
  toolTrace?: ToolTraceEntry[]
  steps?: number
  lastFinishReason?: string | null
  usage?: JobUsageTotals
  /** Wall-clock ms when the job became terminal (for TTL). */
  terminalAtMs?: number
}

export type JobStoreOptions = {
  ttlMs: number
  maxJobs: number
  maxConcurrency: number
  now?: () => number
}

const TERMINAL: ReadonlySet<AgentJobStatus> = new Set(['succeeded', 'failed'])

/**
 * In-memory job store for single-replica travel-agent.
 * Not safe across multiple pods — keep replicas=1.
 */
export class InMemoryJobStore {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly queue: string[] = []
  private runningCount = 0
  private readonly ttlMs: number
  private readonly maxJobs: number
  private readonly maxConcurrency: number
  private readonly now: () => number

  constructor(opts: JobStoreOptions) {
    this.ttlMs = opts.ttlMs
    this.maxJobs = opts.maxJobs
    this.maxConcurrency = Math.max(1, opts.maxConcurrency)
    this.now = opts.now ?? Date.now
  }

  get maxConcurrencyLimit(): number {
    return this.maxConcurrency
  }

  get running(): number {
    return this.runningCount
  }

  get queued(): number {
    return this.queue.length
  }

  get size(): number {
    return this.jobs.size
  }

  create(
    request: AgentAskRequest,
    meta: { requestId: string },
  ): JobRecord {
    this.purgeExpired()
    this.enforceCapacity()

    const jobId = randomUUID()
    const createdAt = new Date(this.now()).toISOString()
    const record: JobRecord = {
      jobId,
      requestId: meta.requestId,
      tripId: request.tripId,
      status: 'queued',
      createdAt,
      request,
      progress: 'queued',
    }
    this.jobs.set(jobId, record)
    this.queue.push(jobId)
    return record
  }

  get(jobId: string): JobRecord | undefined {
    this.purgeExpired()
    return this.jobs.get(jobId)
  }

  toPublic(job: JobRecord): AgentJobStatusResponse {
    const out: AgentJobStatusResponse = {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
    }
    if (job.startedAt) out.startedAt = job.startedAt
    if (job.finishedAt) out.finishedAt = job.finishedAt
    if (job.progress) out.progress = job.progress
    if (job.toolTrace?.length) out.toolTrace = job.toolTrace
    if (job.status === 'succeeded' && job.proposal) {
      out.proposal = job.proposal
    }
    if (job.status === 'failed' && job.error) {
      out.error = job.error
    }
    return out
  }

  /** Dequeue next queued job if under concurrency cap. */
  claimNext(): JobRecord | undefined {
    this.purgeExpired()
    if (this.runningCount >= this.maxConcurrency) return undefined
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()
      if (!jobId) return undefined
      const job = this.jobs.get(jobId)
      if (!job || job.status !== 'queued' || !job.request) continue
      job.status = 'running'
      job.startedAt = new Date(this.now()).toISOString()
      job.progress = 'running'
      this.runningCount += 1
      return job
    }
    return undefined
  }

  markSucceeded(jobId: string, proposal: AgentProposal, meta?: {
    steps?: number
    lastFinishReason?: string | null
    usage?: JobUsageTotals
  }): void {
    const job = this.jobs.get(jobId)
    if (!job || TERMINAL.has(job.status)) return
    if (job.status === 'running') this.runningCount = Math.max(0, this.runningCount - 1)
    job.status = 'succeeded'
    job.proposal = proposal
    job.toolTrace = proposal.toolTrace
    if (meta?.steps !== undefined) job.steps = meta.steps
    if (meta?.lastFinishReason !== undefined) {
      job.lastFinishReason = meta.lastFinishReason
    }
    if (meta?.usage) job.usage = meta.usage
    job.progress = 'succeeded'
    job.finishedAt = new Date(this.now()).toISOString()
    job.terminalAtMs = this.now()
    delete job.request
    delete job.error
  }

  markFailed(
    jobId: string,
    error: JobError,
    meta?: {
      toolTrace?: ToolTraceEntry[]
      steps?: number
      lastFinishReason?: string | null
      usage?: JobUsageTotals
    },
  ): void {
    const job = this.jobs.get(jobId)
    if (!job || TERMINAL.has(job.status)) return
    if (job.status === 'running') this.runningCount = Math.max(0, this.runningCount - 1)
    job.status = 'failed'
    job.error = error
    if (meta?.toolTrace) job.toolTrace = meta.toolTrace
    if (meta?.steps !== undefined) job.steps = meta.steps
    if (meta?.lastFinishReason !== undefined) {
      job.lastFinishReason = meta.lastFinishReason
    }
    if (meta?.usage) job.usage = meta.usage
    job.progress = 'failed'
    job.finishedAt = new Date(this.now()).toISOString()
    job.terminalAtMs = this.now()
    delete job.request
    delete job.proposal
  }

  purgeExpired(): number {
    const cutoff = this.now() - this.ttlMs
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (job.terminalAtMs !== undefined && job.terminalAtMs < cutoff) {
        this.jobs.delete(id)
        removed += 1
      }
    }
    return removed
  }

  /** Drop oldest terminal jobs if over maxJobs; never drop running/queued unless forced. */
  private enforceCapacity(): void {
    if (this.jobs.size < this.maxJobs) return
    this.purgeExpired()
    if (this.jobs.size < this.maxJobs) return

    const terminals = [...this.jobs.values()]
      .filter((j) => TERMINAL.has(j.status))
      .sort((a, b) => (a.terminalAtMs ?? 0) - (b.terminalAtMs ?? 0))

    for (const job of terminals) {
      if (this.jobs.size < this.maxJobs) break
      this.jobs.delete(job.jobId)
    }

    if (this.jobs.size >= this.maxJobs) {
      throw new Error('AGENT_JOB_MAX_JOBS exceeded; try again later')
    }
  }
}

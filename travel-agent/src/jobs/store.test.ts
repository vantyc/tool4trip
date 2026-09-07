import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  agentAskRequestSchema,
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
} from '../../shared/agentContracts.ts'
import { AgentRuntimeError } from '../llm/config.ts'
import { InMemoryJobStore } from './store.ts'
import { JobWorker } from './worker.ts'
import { createJobSystem } from './system.ts'

function sampleRequest(prompt = 'hola'): AgentAskRequest {
  return agentAskRequestSchema.parse({
    prompt,
    tripId: 'trip-1',
    locale: 'es',
    context: {
      trip: {
        id: 'trip-1',
        title: 'Test',
        startDate: '2026-11-01',
        endDate: '2026-11-03',
        status: 'planned',
      },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [],
    },
  })
}

function validProposal(narrative = 'ok'): AgentProposal {
  return agentProposalSchema.parse({
    proposalId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-07T12:00:00+00:00',
    narrative,
    warnings: [],
    diffSummary: [],
    package: {
      schemaVersion: 1,
      packageId: 'pkg-1',
      revision: 1,
      generatedAt: '2026-09-07T12:00:00+00:00',
      trip: {
        title: 'Test',
        startDate: '2026-11-01',
        endDate: '2026-11-03',
      },
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
    ops: [],
    toolTrace: [
      {
        tool: 'webSearch',
        ok: true,
        sources: [{ url: 'https://example.com', title: 'ex' }],
        checkedAt: '2026-09-07T12:00:00+00:00',
      },
    ],
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  store: InMemoryJobStore,
  jobId: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const job = store.get(jobId)
    if (job?.status === status) return
    await sleep(10)
  }
  const job = store.get(jobId)
  assert.fail(`timeout waiting for ${status}, got ${job?.status}`)
}

describe('InMemoryJobStore + JobWorker', () => {
  it('1: create job → queued', () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    const job = store.create(sampleRequest(), { requestId: 'req-1' })
    assert.equal(job.status, 'queued')
    assert.equal(job.tripId, 'trip-1')
    assert.match(job.jobId, /^[0-9a-f-]{36}$/i)
    assert.equal(store.toPublic(job).status, 'queued')
    assert.equal(store.toPublic(job).proposal, undefined)
  })

  it('2: worker → running → succeeded + Zod proposal + toolTrace', async () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    const proposal = validProposal('async ok')
    const worker = new JobWorker({
      store,
      cfg: { provider: 'openai-compatible', model: 'gpt-4.1-mini', timeoutMs: 180_000 },
      run: async () => proposal,
    })
    const created = store.create(sampleRequest(), { requestId: 'req-2' })
    worker.kick()
    await waitFor(store, created.jobId, 'succeeded')
    const pub = store.toPublic(store.get(created.jobId)!)
    assert.equal(pub.status, 'succeeded')
    assert.ok(pub.proposal)
    assert.equal(agentProposalSchema.parse(pub.proposal).narrative, 'async ok')
    assert.equal(pub.toolTrace?.[0]?.tool, 'webSearch')
    assert.equal(pub.error, undefined)
  })

  it('3: worker → failed', async () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    const worker = new JobWorker({
      store,
      cfg: { provider: 'openai-compatible', model: 'gpt-4.1-mini', timeoutMs: 180_000 },
      run: async () => {
        throw new AgentRuntimeError('boom', 'agent_runtime')
      },
    })
    const created = store.create(sampleRequest(), { requestId: 'req-3' })
    worker.kick()
    await waitFor(store, created.jobId, 'failed')
    const pub = store.toPublic(store.get(created.jobId)!)
    assert.equal(pub.status, 'failed')
    assert.equal(pub.error?.message, 'boom')
    assert.equal(pub.error?.code, 'agent_runtime')
    assert.equal(pub.proposal, undefined)
  })

  it('4: timeout interno (runner throws llm_timeout)', async () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    const worker = new JobWorker({
      store,
      cfg: { provider: 'openai-compatible', model: 'gpt-4.1-mini', timeoutMs: 50 },
      run: async () => {
        throw new AgentRuntimeError('LLM timeout / aborted', 'llm_timeout')
      },
    })
    const created = store.create(sampleRequest(), { requestId: 'req-4' })
    worker.kick()
    await waitFor(store, created.jobId, 'failed')
    assert.equal(store.get(created.jobId)?.error?.code, 'llm_timeout')
  })

  it('5: max concurrency queues second job', async () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const worker = new JobWorker({
      store,
      cfg: { provider: 'openai-compatible', model: 'gpt-4.1-mini', timeoutMs: 180_000 },
      run: async () => {
        await gate
        return validProposal('done')
      },
    })
    const a = store.create(sampleRequest('a'), { requestId: 'ra' })
    const b = store.create(sampleRequest('b'), { requestId: 'rb' })
    worker.kick()
    await sleep(30)
    assert.equal(store.get(a.jobId)?.status, 'running')
    assert.equal(store.get(b.jobId)?.status, 'queued')
    assert.equal(store.running, 1)
    release()
    await waitFor(store, a.jobId, 'succeeded')
    await waitFor(store, b.jobId, 'succeeded')
  })

  it('6: TTL cleanup removes terminal jobs', () => {
    let now = 1_000_000
    const store = new InMemoryJobStore({
      ttlMs: 1_000,
      maxJobs: 10,
      maxConcurrency: 1,
      now: () => now,
    })
    const job = store.create(sampleRequest(), { requestId: 'req-ttl' })
    store.markSucceeded(job.jobId, validProposal())
    assert.ok(store.get(job.jobId))
    now += 1_001
    assert.equal(store.purgeExpired(), 1)
    assert.equal(store.get(job.jobId), undefined)
  })

  it('7: unknown job → get undefined (HTTP maps to 404)', () => {
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
    })
    assert.equal(store.get('00000000-0000-4000-8000-000000000000'), undefined)
  })

  it('8+9: createJobSystem preserves proposal Zod + toolTrace', async () => {
    const system = createJobSystem({
      cfg: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        apiKey: 'x',
        tavilyApiKey: 'y',
        timeoutMs: 180_000,
        maxTokens: 4096,
        maxToolCalls: 6,
        maxSteps: 8,
        enableWebTools: true,
        webSearchProvider: 'tavily',
        enableDdgFallback: false,
      },
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
      run: async () => validProposal('system'),
    })
    const { jobId } = system.enqueue(sampleRequest())
    await waitFor(system.store, jobId, 'succeeded')
    const pub = system.store.toPublic(system.store.get(jobId)!)
    agentProposalSchema.parse(pub.proposal)
    assert.equal(pub.toolTrace?.length, 1)
  })
})

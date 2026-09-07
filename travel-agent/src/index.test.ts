import assert from 'node:assert/strict'
import http from 'node:http'
import { after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  agentAskRequestSchema,
  agentJobCreateResponseSchema,
  agentJobStatusResponseSchema,
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
} from '../shared/agentContracts.ts'
import { AgentConfigError, loadLlmEnv } from './llm/config.ts'
import { createJobSystem } from './jobs/system.ts'
import { InMemoryJobStore } from './jobs/store.ts'
import { JobWorker } from './jobs/worker.ts'

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sampleBody(): AgentAskRequest {
  return agentAskRequestSchema.parse({
    prompt: 'hola',
    tripId: 't1',
    context: {
      trip: {
        title: 'X',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
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

function validProposal(): AgentProposal {
  return agentProposalSchema.parse({
    proposalId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-09-07T12:00:00+00:00',
    narrative: 'http ok',
    warnings: [],
    diffSummary: [],
    package: {
      schemaVersion: 1,
      packageId: 'pkg-http',
      revision: 1,
      generatedAt: '2026-09-07T12:00:00+00:00',
      trip: {
        title: 'X',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
      },
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
    ops: [],
    toolTrace: [],
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('HTTP async jobs (in-process)', () => {
  let server: http.Server
  let base = ''

  it('healthz + ask 202 + poll succeeded; unknown job 404; missing keys 503', async () => {
    const cfg = loadLlmEnv({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_MODEL: 'gpt-4.1-mini',
      LLM_API_KEY: 'test-key',
      TAVILY_API_KEY: 'tvly-test',
      ENABLE_WEB_TOOLS: '1',
      WEB_SEARCH_PROVIDER: 'tavily',
      LLM_TIMEOUT_MS: '180000',
    })

    const system = createJobSystem({
      cfg,
      maxConcurrency: 1,
      ttlMs: 60_000,
      maxJobs: 20,
      run: async () => {
        await sleep(20)
        return validProposal()
      },
    })

    const JOB_PATH = /^\/api\/agent\/jobs\/([^/]+)$/

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok\n')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/ask') {
        try {
          // Simulate missing keys path via header
          if (req.headers['x-force-unconfigured'] === '1') {
            throw new AgentConfigError('LLM_API_KEY ausente')
          }
          const raw = await readBody(req)
          const parsed = agentAskRequestSchema.safeParse(JSON.parse(raw || '{}'))
          if (!parsed.success) {
            sendJson(res, 400, { error: 'invalid request' })
            return
          }
          const created = system.enqueue(parsed.data, { requestId: randomUUID() })
          sendJson(
            res,
            202,
            agentJobCreateResponseSchema.parse({
              jobId: created.jobId,
              status: 'queued',
            }),
          )
        } catch (err) {
          if (err instanceof AgentConfigError) {
            sendJson(res, 503, { error: err.message, code: err.code })
            return
          }
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'error',
          })
        }
        return
      }
      const m = JOB_PATH.exec(url.pathname)
      if (req.method === 'GET' && m) {
        const job = system.store.get(decodeURIComponent(m[1]!))
        if (!job) {
          sendJson(res, 404, { error: 'job not found', code: 'job_not_found' })
          return
        }
        sendJson(res, 200, agentJobStatusResponseSchema.parse(system.store.toPublic(job)))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    base = `http://127.0.0.1:${addr.port}`

    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)

    const unconfigured = await fetch(`${base}/api/agent/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-force-unconfigured': '1',
      },
      body: JSON.stringify(sampleBody()),
    })
    assert.equal(unconfigured.status, 503)

    const ask = await fetch(`${base}/api/agent/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleBody()),
    })
    assert.equal(ask.status, 202)
    const created = agentJobCreateResponseSchema.parse(await ask.json())
    assert.equal(created.status, 'queued')

    // HTTP returns in ms — work continues async (no long-held request).
    let status = agentJobStatusResponseSchema.parse(
      await (await fetch(`${base}/api/agent/jobs/${created.jobId}`)).json(),
    )
    const t0 = Date.now()
    while (status.status !== 'succeeded' && Date.now() - t0 < 2000) {
      await sleep(15)
      status = agentJobStatusResponseSchema.parse(
        await (await fetch(`${base}/api/agent/jobs/${created.jobId}`)).json(),
      )
    }
    assert.equal(status.status, 'succeeded')
    assert.ok(status.proposal)
    assert.equal(status.proposal?.ops.length, 0)

    const missing = await fetch(`${base}/api/agent/jobs/${randomUUID()}`)
    assert.equal(missing.status, 404)
  })

  it('long job >60s simulated does not block create response', async () => {
    let now = 0
    const store = new InMemoryJobStore({
      ttlMs: 60_000,
      maxJobs: 10,
      maxConcurrency: 1,
      now: () => now,
    })
    const worker = new JobWorker({
      store,
      cfg: {
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
        timeoutMs: 180_000,
      },
      run: async () => {
        // Simulate >60s wall work without sleeping wall clock in test.
        now += 70_000
        return validProposal()
      },
    })
    const tCreate = Date.now()
    const job = store.create(sampleBody(), { requestId: 'long' })
    worker.kick()
    const createElapsed = Date.now() - tCreate
    assert.ok(createElapsed < 100, `create should be instant, got ${createElapsed}ms`)
    // Allow microtasks
    await sleep(20)
    assert.equal(store.get(job.jobId)?.status, 'succeeded')
  })

  after(async () => {
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })
})

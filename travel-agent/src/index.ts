import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  agentAskRequestSchema,
  agentJobCreateResponseSchema,
  agentJobStatusResponseSchema,
  agentProposalSchema,
} from '../shared/agentContracts.ts'
import {
  AgentConfigError,
  AgentRuntimeError,
  assertLlmReady,
  assertWebSearchReady,
  loadLlmEnv,
} from './llm/config.ts'
import { buildProposal, buildProposalWithMeta } from './propose.ts'
import { createJobSystem } from './jobs/system.ts'
import { logJobEvent } from './jobs/log.ts'

const addr = process.env.LISTEN_ADDR || ':8080'
const cfg = loadLlmEnv()

const jobs = createJobSystem({
  cfg,
  run: (req, meta) =>
    buildProposalWithMeta(req, {
      cfg,
      jobId: meta.jobId,
      requestId: meta.requestId,
    }),
})

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
) {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(raw)
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof AgentConfigError || err instanceof AgentRuntimeError) {
    return err.message
  }
  if (err instanceof Error) return err.message
  return 'agent error'
}

async function parseAskBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<ReturnType<typeof agentAskRequestSchema.parse> | null> {
  const raw = await readBody(req)
  let json: unknown
  try {
    json = JSON.parse(raw || '{}')
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return null
  }
  const parsed = agentAskRequestSchema.safeParse(json)
  if (!parsed.success) {
    sendJson(res, 400, {
      error: 'invalid request',
      details: parsed.error.flatten(),
    })
    return null
  }
  return parsed.data
}

function ensureAgentReady(res: http.ServerResponse): boolean {
  try {
    assertLlmReady(cfg)
    if (cfg.enableWebTools) assertWebSearchReady(cfg)
    return true
  } catch (err) {
    if (err instanceof AgentConfigError) {
      sendJson(res, 503, { error: err.message, code: err.code })
      return false
    }
    sendJson(res, 500, { error: safeErrorMessage(err) })
    return false
  }
}

const JOB_PATH = /^\/api\/agent\/jobs\/([^/]+)$/

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const requestId = randomUUID()

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok\n')
    return
  }

  // Production async path: accept + queue, return immediately.
  if (req.method === 'POST' && url.pathname === '/api/agent/ask') {
    try {
      if (!ensureAgentReady(res)) return
      const data = await parseAskBody(req, res)
      if (!data) return
      const created = jobs.enqueue(data, { requestId })
      const body = agentJobCreateResponseSchema.parse({
        jobId: created.jobId,
        status: 'queued',
      })
      logJobEvent('ask_accepted', {
        requestId,
        jobId: created.jobId,
        tripId: data.tripId,
        status: 'queued',
        provider: cfg.provider,
        model: cfg.model,
      })
      sendJson(res, 202, body)
    } catch (err) {
      console.error('ask error', safeErrorMessage(err))
      sendJson(res, 503, {
        error: safeErrorMessage(err),
        code: 'job_enqueue',
      })
    }
    return
  }

  // Dev/test sync path — disabled in production unless ENABLE_ASK_SYNC=1.
  if (req.method === 'POST' && url.pathname === '/api/agent/ask/sync') {
    if (process.env.ENABLE_ASK_SYNC !== '1') {
      sendJson(res, 404, { error: 'not found', code: 'sync_disabled' })
      return
    }
    try {
      if (!ensureAgentReady(res)) return
      const data = await parseAskBody(req, res)
      if (!data) return
      const t0 = Date.now()
      const proposal = await buildProposal(data, { cfg })
      logJobEvent('ask_sync_done', {
        requestId,
        tripId: data.tripId,
        status: 'succeeded',
        durationMs: Date.now() - t0,
        provider: cfg.provider,
        model: cfg.model,
      })
      sendJson(res, 200, agentProposalSchema.parse(proposal))
    } catch (err) {
      console.error('ask sync error', safeErrorMessage(err))
      if (err instanceof AgentConfigError) {
        sendJson(res, 503, { error: err.message, code: err.code })
        return
      }
      if (err instanceof AgentRuntimeError) {
        const status = err.code === 'llm_timeout' ? 504 : 502
        sendJson(res, status, { error: err.message, code: err.code })
        return
      }
      sendJson(res, 500, { error: safeErrorMessage(err) })
    }
    return
  }

  const jobMatch = JOB_PATH.exec(url.pathname)
  if (req.method === 'GET' && jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]!)
    const job = jobs.store.get(jobId)
    if (!job) {
      sendJson(res, 404, { error: 'job not found', code: 'job_not_found' })
      return
    }
    sendJson(res, 200, agentJobStatusResponseSchema.parse(jobs.store.toPublic(job)))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found\n')
})

const port = Number(addr.replace(/^:/, '')) || 8080
server.listen(port, () => {
  const modelLabel = cfg.model || 'unset'
  console.log(
    [
      `travel-agent listening on ${port}`,
      `provider=${cfg.provider}`,
      `model=${modelLabel}`,
      `webTools=${cfg.enableWebTools}`,
      `search=${cfg.webSearchProvider}`,
      'mode=async-jobs',
      `timeoutMs=${cfg.timeoutMs}`,
    ].join(' '),
  )
})

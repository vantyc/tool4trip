import assert from 'node:assert/strict'
import http from 'node:http'
import { after, describe, it } from 'node:test'
import {
  agentAskRequestSchema,
  agentProposalSchema,
} from '../shared/agentContracts.ts'
import { AgentConfigError, AgentRuntimeError, loadLlmEnv } from './llm/config.ts'
import { buildProposal } from './propose.ts'

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

describe('HTTP healthz (in-process)', () => {
  let server: http.Server
  let base = ''

  it('I: /healthz works; ask without keys → 503', async () => {
    // Mirror index.ts handler without requiring LLM env at boot
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok\n')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/ask') {
        try {
          const raw = await readBody(req)
          const parsed = agentAskRequestSchema.safeParse(JSON.parse(raw || '{}'))
          if (!parsed.success) {
            sendJson(res, 400, { error: 'invalid request' })
            return
          }
          const proposal = await buildProposal(parsed.data, {
            cfg: loadLlmEnv({
              LLM_PROVIDER: 'openai-compatible',
              LLM_BASE_URL: '',
              LLM_MODEL: '',
              LLM_API_KEY: '',
              ENABLE_WEB_TOOLS: '1',
              WEB_SEARCH_PROVIDER: 'tavily',
            }),
          })
          sendJson(res, 200, agentProposalSchema.parse(proposal))
        } catch (err) {
          if (err instanceof AgentConfigError) {
            sendJson(res, 503, { error: err.message, code: err.code })
            return
          }
          if (err instanceof AgentRuntimeError) {
            sendJson(res, 502, { error: err.message, code: err.code })
            return
          }
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'error',
          })
        }
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
    assert.equal((await health.text()).trim(), 'ok')

    const ask = await fetch(`${base}/api/agent/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
    })
    assert.equal(ask.status, 503)
    const body = (await ask.json()) as { code?: string }
    assert.equal(body.code, 'agent_config')
  })

  after(async () => {
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })
})

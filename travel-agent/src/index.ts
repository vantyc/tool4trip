import http from 'node:http'
import {
  agentAskRequestSchema,
  agentProposalSchema,
} from '../shared/agentContracts.ts'
import { AgentConfigError, AgentRuntimeError, loadLlmEnv } from './llm/config.ts'
import { buildProposal } from './propose.ts'

const addr = process.env.LISTEN_ADDR || ':8080'

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok\n')
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/ask') {
    try {
      const raw = await readBody(req)
      let json: unknown
      try {
        json = JSON.parse(raw || '{}')
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const parsed = agentAskRequestSchema.safeParse(json)
      if (!parsed.success) {
        sendJson(res, 400, {
          error: 'invalid request',
          details: parsed.error.flatten(),
        })
        return
      }
      const proposal = await buildProposal(parsed.data)
      sendJson(res, 200, agentProposalSchema.parse(proposal))
    } catch (err) {
      // Never log secrets — message only
      console.error('ask error', safeErrorMessage(err))
      if (err instanceof AgentConfigError) {
        sendJson(res, 503, {
          error: err.message,
          code: err.code,
        })
        return
      }
      if (err instanceof AgentRuntimeError) {
        const status = err.code === 'llm_timeout' ? 504 : 502
        sendJson(res, status, {
          error: err.message,
          code: err.code,
        })
        return
      }
      sendJson(res, 500, {
        error: safeErrorMessage(err),
      })
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found\n')
})

const port = Number(addr.replace(/^:/, '')) || 8080
server.listen(port, () => {
  const cfg = loadLlmEnv()
  console.log(
    `travel-agent listening on ${port} provider=${cfg.provider} model=${cfg.model || '(unset)'} webTools=${cfg.enableWebTools} search=${cfg.webSearchProvider}`,
  )
})

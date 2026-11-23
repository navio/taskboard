import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createTaskboardMcpServer, type BotIdentity } from './mcp-server'

const botIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

type RemoteMcpServerOptions = {
  token: string
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

function isValidToken(request: IncomingMessage, expectedToken: string) {
  const authorization = headerValue(request, 'authorization')
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i)
  if (!match) {
    return false
  }

  const actual = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function botIdentity(request: IncomingMessage): BotIdentity | undefined {
  const id = headerValue(request, 'x-taskboard-bot-id')
  const name = headerValue(request, 'x-taskboard-bot-name')?.trim()
  const description = headerValue(request, 'x-taskboard-bot-description')?.trim()

  if (!id || !botIdPattern.test(id) || !name || name.length > 120) {
    return undefined
  }
  if (description && description.length > 500) {
    return undefined
  }

  return { id, name, description: description || undefined }
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedToken: string,
) {
  if (!isValidToken(request, expectedToken)) {
    response.setHeader('www-authenticate', 'Bearer')
    json(response, 401, { error: 'Unauthorized' })
    return
  }

  const bot = botIdentity(request)
  if (!bot) {
    json(response, 400, {
      error:
        'Send X-Taskboard-Bot-Id and X-Taskboard-Bot-Name headers with a valid bot identity.',
    })
    return
  }

  const server = createTaskboardMcpServer(bot)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    void Promise.allSettled([transport.close(), server.close()])
  }

  response.once('close', close)

  try {
    response.setHeader('cache-control', 'no-store')
    await server.connect(transport)
    await transport.handleRequest(request, response)
  } catch (error) {
    close()
    if (!response.headersSent) {
      json(response, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
    const message = error instanceof Error ? error.message : 'Unexpected MCP HTTP error.'
    process.stderr.write(`taskboard-mcp-http: ${message}\n`)
  }
}

export function createRemoteMcpHttpServer({ token }: RemoteMcpServerOptions): Server {
  if (token.length < 32 || token.trim() !== token) {
    throw new Error('TASKBOARD_MCP_TOKEN must be a non-whitespace value of at least 32 characters.')
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

    if (pathname === '/healthz' && request.method === 'GET') {
      json(response, 200, { ok: true })
      return
    }

    if (pathname !== '/mcp') {
      json(response, 404, { error: 'Not found' })
      return
    }

    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      json(response, 405, { error: 'Method not allowed' })
      return
    }

    void handleMcpRequest(request, response, token)
  })

  server.requestTimeout = 60_000
  server.headersTimeout = 65_000
  return server
}

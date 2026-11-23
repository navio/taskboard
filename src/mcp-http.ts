import { closeDatabase } from './server/db'
import { createRemoteMcpHttpServer } from './mcp-http-server'

function readPort(value: string | undefined) {
  const port = Number(value ?? '3001')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TASKBOARD_MCP_PORT must be an integer between 1 and 65535.')
  }
  return port
}

async function main() {
  const token = process.env.TASKBOARD_MCP_TOKEN
  if (!token) {
    throw new Error('Set TASKBOARD_MCP_TOKEN to a random value of at least 32 characters.')
  }

  const host = process.env.TASKBOARD_MCP_HOST ?? '0.0.0.0'
  const port = readPort(process.env.TASKBOARD_MCP_PORT)
  const server = createRemoteMcpHttpServer({ token })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  process.stdout.write(`Taskboard MCP HTTP listening on http://${host}:${port}/mcp\n`)

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) {
      return
    }
    stopping = true
    server.close((error) => {
      closeDatabase()
      if (error) {
        process.stderr.write(`taskboard-mcp-http: ${error.message}\n`)
        process.exitCode = 1
      }
      process.exit()
    })
    process.stderr.write(`Taskboard MCP HTTP received ${signal}; shutting down.\n`)
  }

  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Taskboard MCP HTTP failed to start.'
  process.stderr.write(`${message}\n`)
  closeDatabase()
  process.exitCode = 1
})

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createTaskboardMcpServer, type BotIdentity } from './mcp-server'
import { closeDatabase } from './server/db'

function argumentValue(flag: string) {
  const index = process.argv.indexOf(flag)
  if (index < 0) {
    return undefined
  }
  return process.argv[index + 1]
}

function readIdentity(): BotIdentity {
  const databasePath = argumentValue('--db')
  if (databasePath) {
    process.env.TASKBOARD_DB_PATH = databasePath
  }

  const id = argumentValue('--bot') ?? process.env.TASKBOARD_BOT_ID
  const name = argumentValue('--name') ?? process.env.TASKBOARD_BOT_NAME
  const description = argumentValue('--description') ?? process.env.TASKBOARD_BOT_DESCRIPTION

  if (!id || !name) {
    throw new Error(
      'Taskboard MCP needs a bot identity. Pass --bot <id> --name <display name>.',
    )
  }

  return { id, name, description }
}

async function main() {
  const server = createTaskboardMcpServer(readIdentity())
  await server.connect(new StdioServerTransport())
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Taskboard MCP failed to start.'
  process.stderr.write(`${message}\n`)
  closeDatabase()
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    closeDatabase()
    process.exit(0)
  })
}

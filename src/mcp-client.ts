import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'

type Mode = 'tools' | 'call'

type ClientOptions = {
  mode: Mode
  toolName?: string
  toolArguments?: Record<string, unknown>
  command: string
  commandArguments: string[]
  cwd?: string
  environment: Record<string, string>
  pretty: boolean
  requestOptions: RequestOptions
  maxBufferSize?: number
}

const usage = `Usage:
  npm run mcp:client -- tools [client-options] -- <server-command> [server-args...]
  npm run mcp:client -- call <tool-name> --args '<JSON object>' [client-options] -- <server-command> [server-args...]

Client options:
  --cwd <path>                    Working directory for the server process
  --env <NAME=VALUE>              Server environment override; repeatable
  --timeout-ms <milliseconds>     Per-request timeout (default: 60000)
  --max-total-timeout-ms <ms>     Absolute request timeout
  --max-buffer-bytes <bytes>      Maximum MCP message buffer size
  --pretty                         Pretty-print JSON output
  --help                           Show this help

Examples:
  npm run mcp:client -- tools -- node ./server.mjs
  npm run mcp:client -- call echo --args '{"message":"hello"}' -- node ./server.mjs
`

let activeClient: Client | undefined
let closing = false

function printUsage() {
  process.stderr.write(usage)
}

function fail(message: string): never {
  throw new Error(message)
}

function requireValue(tokens: string[], index: number, flag: string) {
  const value = tokens[index + 1]
  if (!value || value === '--') {
    fail(`${flag} needs a value.`)
  }
  return value
}

function parsePositiveInteger(value: string, flag: string) {
  if (!/^\d+$/.test(value)) {
    fail(`${flag} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer.`)
  }
  return parsed
}

function parseEnvironment(value: string) {
  const separator = value.indexOf('=')
  if (separator <= 0) {
    fail('--env must use NAME=VALUE.')
  }

  const name = value.slice(0, separator)
  const environmentValue = value.slice(separator + 1)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail(`Invalid environment variable name: ${name}`)
  }
  return { name, value: environmentValue }
}

function parseJsonObject(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('--args must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === '--args must be a JSON object.') {
      throw error
    }
    fail('--args must contain valid JSON.')
  }
}

function parseOptions(tokens: string[]): ClientOptions | { help: true } {
  if (!tokens.length || tokens[0] === '--help' || tokens[0] === '-h') {
    return { help: true }
  }

  const mode = tokens[0]
  if (mode !== 'tools' && mode !== 'call') {
    fail(`Unknown command: ${mode}. Use tools or call.`)
  }

  let position = 1
  let toolName: string | undefined
  if (mode === 'call') {
    toolName = tokens[position]
    if (!toolName || toolName.startsWith('--')) {
      fail('call needs a tool name.')
    }
    position += 1
  }

  let toolArguments: Record<string, unknown> | undefined
  let cwd: string | undefined
  const environment: Record<string, string> = {}
  let timeout: number | undefined
  let maxTotalTimeout: number | undefined
  let maxBufferSize: number | undefined
  let pretty = false
  let delimiter = -1

  for (; position < tokens.length; position += 1) {
    const token = tokens[position]
    if (token === '--') {
      delimiter = position
      break
    }
    if (token === '--help' || token === '-h') {
      return { help: true }
    }
    if (token === '--pretty') {
      pretty = true
      continue
    }
    if (token === '--args') {
      toolArguments = parseJsonObject(requireValue(tokens, position, token))
      position += 1
      continue
    }
    if (token === '--cwd') {
      cwd = requireValue(tokens, position, token)
      position += 1
      continue
    }
    if (token === '--env') {
      const entry = parseEnvironment(requireValue(tokens, position, token))
      environment[entry.name] = entry.value
      position += 1
      continue
    }
    if (token === '--timeout-ms') {
      timeout = parsePositiveInteger(requireValue(tokens, position, token), token)
      position += 1
      continue
    }
    if (token === '--max-total-timeout-ms') {
      maxTotalTimeout = parsePositiveInteger(requireValue(tokens, position, token), token)
      position += 1
      continue
    }
    if (token === '--max-buffer-bytes') {
      maxBufferSize = parsePositiveInteger(requireValue(tokens, position, token), token)
      position += 1
      continue
    }
    fail(`Unknown option: ${token}`)
  }

  if (delimiter < 0) {
    fail('Separate client options from the server command with --.')
  }

  const [command, ...commandArguments] = tokens.slice(delimiter + 1)
  if (!command) {
    fail('Provide a local stdio MCP server command after --.')
  }
  if (mode === 'call' && toolArguments === undefined) {
    fail('call needs --args with a JSON object.')
  }
  if (mode === 'tools' && toolArguments !== undefined) {
    fail('--args is only valid with call.')
  }

  return {
    mode,
    toolName,
    toolArguments,
    command,
    commandArguments,
    cwd,
    environment,
    pretty,
    requestOptions: {
      timeout,
      maxTotalTimeout,
    },
    maxBufferSize,
  }
}

async function listEveryTool(client: Client, requestOptions: RequestOptions) {
  const tools: unknown[] = []
  let cursor: string | undefined

  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, requestOptions)
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)

  return { tools }
}

function isToolError(result: unknown) {
  return (
    typeof result === 'object' &&
    result !== null &&
    'isError' in result &&
    result.isError === true
  )
}

export async function runClient(options: ClientOptions) {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.commandArguments,
    cwd: options.cwd,
    env: {
      ...getDefaultEnvironment(),
      ...options.environment,
    },
    stderr: 'inherit',
    maxBufferSize: options.maxBufferSize,
  })
  const client = new Client({ name: 'local-mcp-client', version: '0.1.0' })
  activeClient = client

  try {
    await client.connect(transport, options.requestOptions)
    if (options.mode === 'tools') {
      return { result: await listEveryTool(client, options.requestOptions), toolError: false }
    }

    const result = await client.callTool(
      {
        name: options.toolName ?? '',
        arguments: options.toolArguments ?? {},
      },
      undefined,
      options.requestOptions,
    )
    return { result, toolError: isToolError(result) }
  } finally {
    activeClient = undefined
    await client.close().catch(() => undefined)
  }
}

async function closeActiveClient() {
  if (closing) {
    return
  }
  closing = true
  await activeClient?.close().catch(() => undefined)
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(signal, () => {
    void closeActiveClient().finally(() => {
      process.exit(exitCode)
    })
  })
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if ('help' in options) {
    printUsage()
    return
  }

  const { result, toolError } = await runClient(options)
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : undefined)}\n`)
  if (toolError) {
    process.exitCode = 2
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected MCP client failure.'
  process.stderr.write(`mcp-client: ${message}\n`)
  process.exitCode = 1
})

import { mkdtempSync, rmSync } from 'node:fs'
import { type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRemoteMcpHttpServer } from './mcp-http-server'
import { closeDatabase } from './server/db'

const token = '0123456789abcdef0123456789abcdef'

let databaseDirectory = ''
let endpoint = ''
let server: Server | undefined
let client: Client | undefined
let originalDatabasePath: string | undefined
let originalSeed: string | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
  closeDatabase()

  if (originalDatabasePath === undefined) {
    delete process.env.TASKBOARD_DB_PATH
  } else {
    process.env.TASKBOARD_DB_PATH = originalDatabasePath
  }
  if (originalSeed === undefined) {
    delete process.env.TASKBOARD_SEED
  } else {
    process.env.TASKBOARD_SEED = originalSeed
  }

  if (databaseDirectory) {
    rmSync(databaseDirectory, { recursive: true, force: true })
  }
})

beforeEach(async () => {
  databaseDirectory = mkdtempSync(join(tmpdir(), 'taskboard-mcp-http-test-'))
  originalDatabasePath = process.env.TASKBOARD_DB_PATH
  originalSeed = process.env.TASKBOARD_SEED
  process.env.TASKBOARD_DB_PATH = join(databaseDirectory, 'taskboard.sqlite')
  process.env.TASKBOARD_SEED = 'false'

  server = createRemoteMcpHttpServer({ token })
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  endpoint = `http://127.0.0.1:${address.port}/mcp`
})

describe('taskboard remote MCP server', () => {
  it('requires a bearer token and exposes the bounded tools to an HTTP MCP client', async () => {
    const unauthorized = await fetch(endpoint, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer')

    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Taskboard-Bot-Id': 'http-test-agent',
          'X-Taskboard-Bot-Name': 'HTTP test agent',
        },
      },
    })
    client = new Client({ name: 'taskboard-http-test-client', version: '0.1.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_tasks', 'create_task', 'claim_task', 'update_task']),
    )
    expect(names).not.toContain('execute_sql')
  })
})

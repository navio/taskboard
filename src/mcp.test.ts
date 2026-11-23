import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

let databaseDirectory = ''
let client: Client | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  if (databaseDirectory) {
    rmSync(databaseDirectory, { recursive: true, force: true })
  }
})

describe('taskboard MCP server', () => {
  it('registers bounded tools and enforces a bot claim before updates', async () => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'taskboard-mcp-test-'))
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
    environment.TASKBOARD_DB_PATH = join(databaseDirectory, 'taskboard.sqlite')
    environment.TASKBOARD_SEED = 'false'

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp.ts', '--bot', 'test-agent', '--name', 'Test agent'],
      cwd: process.cwd(),
      env: environment,
      stderr: 'pipe',
    })
    client = new Client({ name: 'taskboard-test-client', version: '0.1.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_tasks', 'create_task', 'claim_task', 'update_task']),
    )
    expect(names).not.toContain('execute_sql')

    const createResult = await client.callTool({
      name: 'create_task',
      arguments: { title: 'MCP integration test', status: 'ready' },
    })
    const created = toolJson<{ task: { id: string } }>(createResult)

    const unclaimedUpdate = await client.callTool({
      name: 'update_task',
      arguments: { task_id: created.task.id, status: 'blocked' },
    })
    expect(unclaimedUpdate.isError).toBe(true)

    const claimResult = await client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.task.id, minutes: 5 },
    })
    const claimed = toolJson<{ task: { status: string; lock: { botId: string } } }>(claimResult)
    expect(claimed.task.status).toBe('in_progress')
    expect(claimed.task.lock.botId).toBe('test-agent')

    const completedResult = await client.callTool({
      name: 'update_task',
      arguments: { task_id: created.task.id, status: 'complete' },
    })
    const completed = toolJson<{ task: { status: string; lock: unknown } }>(completedResult)
    expect(completed.task.status).toBe('complete')
    expect(completed.task.lock).toBeNull()
  })
})

function toolJson<T>(result: unknown) {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('Expected the MCP tool to return content.')
  }

  const block = result.content.find(
    (candidate): candidate is { type: 'text'; text: string } =>
      Boolean(candidate) &&
      typeof candidate === 'object' &&
      'type' in candidate &&
      'text' in candidate &&
      candidate.type === 'text' &&
      typeof candidate.text === 'string',
  )
  if (!block) {
    throw new Error('Expected the MCP tool to return JSON text.')
  }
  return JSON.parse(block.text) as T
}

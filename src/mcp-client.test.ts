import { execFile as execFileCallback } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
let databaseDirectory = ''

afterEach(() => {
  if (databaseDirectory) {
    rmSync(databaseDirectory, { recursive: true, force: true })
  }
})

describe('generic MCP client CLI', () => {
  it('lists and calls tools on a generic local stdio server command', async () => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'taskboard-mcp-client-test-'))
    const databasePath = join(databaseDirectory, 'taskboard.sqlite')
    const serverCommand = [
      process.execPath,
      '--import',
      'tsx',
      'src/mcp.ts',
      '--bot',
      'client-test-bot',
      '--name',
      'Client test bot',
    ]

    const tools = await runClientCommand([
      'tools',
      '--env',
      `TASKBOARD_DB_PATH=${databasePath}`,
      '--env',
      'TASKBOARD_SEED=false',
      '--',
      ...serverCommand,
    ])
    const toolPayload = JSON.parse(tools.stdout) as { tools: Array<{ name: string }> }
    expect(toolPayload.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_tasks', 'create_task', 'claim_task']),
    )
    expect(tools.stderr).toBe('')

    const created = await runClientCommand([
      'call',
      'create_task',
      '--args',
      '{"title":"Created by the generic client","status":"ready"}',
      '--env',
      `TASKBOARD_DB_PATH=${databasePath}`,
      '--env',
      'TASKBOARD_SEED=false',
      '--',
      ...serverCommand,
    ])
    const callPayload = JSON.parse(created.stdout) as {
      content: Array<{ type: string; text?: string }>
    }
    const task = toolTextJson<{ task: { title: string; status: string } }>(callPayload)
    expect(task.task).toMatchObject({
      title: 'Created by the generic client',
      status: 'ready',
    })
    expect(created.stderr).toBe('')
  })
})

function runClientCommand(argumentsList: string[]) {
  return execFile(
    process.execPath,
    ['--import', 'tsx', 'src/mcp-client.ts', ...argumentsList],
    { cwd: process.cwd() },
  )
}

function toolTextJson<T>(payload: { content: Array<{ type: string; text?: string }> }) {
  const text = payload.content.find(
    (block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string',
  )
  if (!text) {
    throw new Error('Expected text content from the MCP server.')
  }
  return JSON.parse(text.text) as T
}

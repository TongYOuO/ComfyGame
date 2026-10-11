import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetch: vi.fn(), send: vi.fn(), build: vi.fn() }))
vi.mock('@/api', () => ({ apiFetch: api.fetch, apiSend: api.send }))
vi.mock('@/stores/projectStore', () => ({ useProjectStore: () => ({ currentProjectId: 'p' }) }))
vi.mock('./stageIdentity', () => ({ ensureStageUid: () => 'uid' }))
vi.mock('./stagePromptBuild', () => ({ buildRunPrompt: api.build }))
import { createAgentStageRun } from './agentStageRun'

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); api.fetch.mockResolvedValue({ tasks: [] }) })
afterEach(() => vi.useRealTimers())

it('submits a snapshot and applies completed output to native downstream state', async () => {
  const state: any = { running: false }
  const store: any = { applyExecutedPayload: vi.fn(), applyExecutionError: vi.fn() }
  api.build.mockResolvedValue({ pid: 'p', targetId: '7', pm: { output: { '7': { inputs: { main_prompt: '肤色素体' } } } } })
  api.send.mockResolvedValue({ task: { id: 't', status: 'queued', error: null } })
  const runner = createAgentStageRun({ node: { id: 7, comfyClass: 'ComfyTV.AgentImageStage' }, state, store, refresh: vi.fn() })
  await runner.onRunRequest()
  expect(api.send.mock.calls[0][3].inputs.main_prompt).toBe('肤色素体')
  expect(state.progress.text).toContain('等待外部 Codex')
  const ui = { output: ['/view?filename=result.png'], output_id: [8] }
  api.fetch.mockResolvedValue({ tasks: [{ id: 't', status: 'completed', error: null, ui }] })
  await vi.advanceTimersByTimeAsync(2100)
  expect(store.applyExecutedPayload).toHaveBeenCalledWith(state, ui)
  runner.dispose()
})

it('restores a claimed task and routes cancellation to that task', async () => {
  api.fetch.mockResolvedValue({ tasks: [{ id: 'old', status: 'claimed', error: null }] })
  api.send.mockResolvedValue({ task: { id: 'old', status: 'cancelled', error: '用户取消' } })
  const state: any = { running: false }
  const store: any = { applyExecutedPayload: vi.fn(), applyExecutionError: vi.fn() }
  const runner = createAgentStageRun({ node: { id: 7 }, state, store, refresh: vi.fn() })
  await vi.advanceTimersByTimeAsync(1)
  expect(state.running).toBe(true)
  await runner.onCancelRequest()
  expect(api.send.mock.calls[0][0]).toBe('/comfytv/agent_tasks/old/cancel')
  expect(store.applyExecutionError).toHaveBeenCalled()
  runner.dispose()
})

it('posts complete region sources separately from resolved inputs and keeps the sent snapshot', async () => {
  const prompt = '区域规则'.repeat(5000)
  const context = { id: 1, comfyClass: 'ComfyTV.AgentContext', title: '美术规范', pos: [0, 0], size: [20, 20],
    widgets: [{ name: 'main_prompt', value: prompt }, { name: 'enabled', value: true }] }
  const node: any = { id: 7, comfyClass: 'ComfyTV.AgentModelStage', pos: [30, 30], size: [20, 20] }
  node.graph = { _nodes: [node, context], _groups: [{ id: 'g', title: '模型区域', pos: [0, 0], size: [100, 100] }] }
  const state: any = { running: false }
  const store: any = { applyExecutedPayload: vi.fn(), applyExecutionError: vi.fn() }
  api.build.mockResolvedValue({ pid: 'p', targetId: '7', pm: { output: { '7': {
    inputs: { main_prompt: '节点任务', 'images.image0': '/view?filename=source.png' },
  } } } })
  api.send.mockResolvedValue({ task: { id: 't', status: 'queued', error: null } })
  const runner = createAgentStageRun({ node, state, store, refresh: vi.fn() })
  try {
    await runner.onRunRequest()
    const body = api.send.mock.calls[0][3]
    expect(body.region_prompts).toEqual([
      { node_id: '1', title: '美术规范', group_id: 'g', group_title: '模型区域', prompt },
    ])
    expect(body.inputs).toEqual({ main_prompt: '节点任务', 'images.image0': '/view?filename=source.png' })
    context.widgets[0].value = '后来修改'
    node.graph._groups[0].title = '后来改组名'
    expect(body.region_prompts[0].prompt).toBe(prompt)
    expect(body.region_prompts[0].group_title).toBe('模型区域')
  } finally { runner.dispose() }
})

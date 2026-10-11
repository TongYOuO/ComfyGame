import { expect, it, vi } from 'vitest'

import { app } from '@/lib/comfyApp'
import { collectRegionPrompts } from './agentRegionPrompts'
import { buildCanvasSnapshot } from './useCanvasMirror'
import { installMcpCommandBus } from './useMcpCommandBus'

type Node = Parameters<typeof collectRegionPrompts>[0]
type Group = NonNullable<NonNullable<Node['graph']>['_groups']>[number]

function context(id: number, pos = [0, 0], prompt = '区域规则'): Node {
  return { id, comfyClass: 'ComfyTV.AgentContext', title: `指令${id}`, pos, size: [20, 20],
    widgets: [{ name: 'main_prompt', value: prompt }, { name: 'enabled', value: true }] }
}

function group(id: string | undefined, pos = [0, 0], size = [100, 100]): Group {
  return { id, title: `组${id ?? '无id'}`, pos, size }
}

function scene(contexts: Node[], groups: Group[], pos = [40, 40]) {
  const target: Node = { id: 9, comfyClass: 'ComfyTV.AgentImageStage', pos, size: [20, 20] }
  const graph = { _nodes: [target, ...contexts], _groups: groups,
    getNodeById: (id: number | string) => graph._nodes.find((node) => String(node.id) === String(id)) }
  for (const node of graph._nodes) node.graph = graph
  return target
}

it('uses inclusive node centers, including Float32Array coordinates', () => {
  const c = context(1, [-10, -10])
  c.pos = new Float32Array(c.pos!)
  c.size = new Float32Array(c.size!)
  const g = group('a')
  g.pos = new Float32Array(g.pos)
  g.size = new Float32Array(g.size)
  const target = scene([c], [g], [90, 90])
  target.pos = new Float32Array(target.pos!)
  target.size = new Float32Array(target.size!)
  expect(collectRegionPrompts(target)).toEqual([
    { node_id: '1', title: '指令1', group_id: 'a', group_title: '组a', prompt: '区域规则' },
  ])
  target.pos = new Float32Array([91, 90])
  expect(collectRegionPrompts(target)).toEqual([])
})

it('ignores groupless contexts and non-Agent stages', () => {
  const target = scene([context(1, [150, 150])], [group('a')])
  expect(collectRegionPrompts(target)).toEqual([])
  target.graph!._groups = []
  expect(collectRegionPrompts(target)).toEqual([])
  target.graph!._groups = [group('a')]
  target.graph!._nodes = [context(2)]
  target.comfyClass = 'ComfyTV.ImageEditStage'
  expect(collectRegionPrompts(target)).toEqual([])
})

it('keeps an inner context in its smallest group while applying outer instructions inward', () => {
  const target = scene([context(1, [140, 140], '外层'), context(2, [10, 10], '内层')],
    [group('outer', [0, 0], [200, 200]), group('inner')])
  expect(collectRegionPrompts(target).map((r) => r.prompt)).toEqual(['外层', '内层'])
  target.pos = [140, 140]
  expect(collectRegionPrompts(target).map((r) => r.prompt)).toEqual(['外层'])
})

it('selects one overlapping owner by area then id, dedupes ids but preserves repeated text', () => {
  const c = context(1)
  const target = scene([context(2), c, c], [group('b'), group('a')])
  expect(collectRegionPrompts(target).map((r) => [r.group_id, r.node_id])).toEqual([['a', '1'], ['a', '2']])
  target.graph!._groups = [group(undefined), group(undefined)]
  expect(collectRegionPrompts(target).map((r) => r.group_id)).toEqual(['0', '0'])
  target.graph!._groups = [group('small', [0, 0], [20, 20]), group('outer')]
  expect(collectRegionPrompts(target)).toEqual([])
})

it('ignores disabled, blank, muted, bypassed contexts and groups with no positive area', () => {
  const disabled = context(1)
  disabled.widgets![1].value = false
  const muted = { ...context(2), mode: 2 }
  const bypassed = { ...context(3), mode: 4 }
  const target = scene([disabled, muted, bypassed, context(4, [0, 0], ' \n\t '), context(5)],
    [group('zero', [0, 0], [0, 100]), group('negative', [0, 0], [-100, -100]), group('valid')])
  expect(collectRegionPrompts(target).map((r) => r.node_id)).toEqual(['5'])
})

it('isolates graphs and sorts group area descending, then group and context ids', () => {
  const target = scene([context(4, [30, 0]), context(3), context(2, [80, 0]), context(1)],
    [group('outer', [0, 0], [200, 200]), group('b', [30, 0], [20, 20]), group('a', [0, 0], [20, 20])], [5, 0])
  expect(collectRegionPrompts(target).map((r) => r.node_id)).toEqual(['2', '1', '3'])
  target.graph!._groups = [group('b', [0, 0], [60, 20]), group('a', [0, 0], [20, 60])]
  target.graph!._nodes = [context(1, [30, 0]), context(2, [0, 30])]
  expect(collectRegionPrompts(target).map((r) => r.group_id)).toEqual(['a', 'b'])
  const other = scene([context(99)], [group('foreign')])
  expect(collectRegionPrompts(other)[0].node_id).toBe('99')
  expect(collectRegionPrompts(target).map((r) => r.node_id)).toEqual(['2', '1'])
})

it('exposes the same full current sources through mirror and get_stage after edits', async () => {
  const c = context(1, [0, 0], '规则'.repeat(10000))
  const target = scene([c], [group('a')])
  const graph = target.graph!
  const host = { graph, api: { addEventListener: vi.fn(), removeEventListener: vi.fn() } }
  const deps = { resolveApp: () => host, resolveProjectId: () => 'p', resolveStageState: () => undefined }
  const mirror = buildCanvasSnapshot(deps)!
  expect(mirror.stages).toHaveLength(1)
  expect(mirror.stages[0].region_prompts).toEqual(collectRegionPrompts(target))
  const fetchApi = (app as any).api.fetchApi as ReturnType<typeof vi.fn>
  fetchApi.mockClear()
  fetchApi.mockResolvedValue(new Response(JSON.stringify({ ok: true })))
  const uninstall = installMcpCommandBus(host, deps)
  try {
    const handler = host.api.addEventListener.mock.calls[0][1]
    await handler({ detail: { id: 'get', action: 'get_stage', node: '9' } })
    const body = JSON.parse(fetchApi.mock.calls[0][1].body)
    expect(body.ok).toBe(true)
    expect(body.result.region_prompts).toEqual(mirror.stages[0].region_prompts)
    c.widgets![0].value = '编辑后的规则'
    expect(buildCanvasSnapshot(deps)!.stages[0].region_prompts[0].prompt).toBe('编辑后的规则')
    expect(mirror.stages[0].region_prompts[0].prompt).toHaveLength(20000)
  } finally { if (uninstall) uninstall() }
})

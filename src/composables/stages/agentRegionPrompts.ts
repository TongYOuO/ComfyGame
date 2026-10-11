export interface RegionPrompt {
  node_id: string
  title: string
  group_id: string
  group_title: string
  prompt: string
}

interface RegionNode {
  id?: string | number
  comfyClass?: string
  type?: string
  title?: string
  mode?: number
  pos?: ArrayLike<number>
  size?: ArrayLike<number>
  widgets?: { name?: string; value?: unknown }[]
  graph?: { _nodes?: RegionNode[]; _groups?: RegionGroup[] } | null
}

interface RegionGroup {
  id?: string | number
  title?: string
  pos: ArrayLike<number>
  size: ArrayLike<number>
}

export function isAgentStage(node: RegionNode): boolean {
  return ['ComfyTV.AgentImageStage', 'ComfyTV.AgentModelStage', 'ComfyTV.AgentTextStage', 'ComfyTV.AgentVideoStage']
    .includes(node.comfyClass ?? node.type ?? '')
}

function contains(group: RegionGroup, node: RegionNode): boolean {
  if (!node.pos || !node.size) return false
  const x = node.pos[0] + node.size[0] / 2
  const y = node.pos[1] + node.size[1] / 2
  return x >= group.pos[0] && x <= group.pos[0] + group.size[0]
    && y >= group.pos[1] && y <= group.pos[1] + group.size[1]
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 先确定指令的最小组归属，再检查目标中心，避免内层指令泄漏到外层。 */
export function collectRegionPrompts(node: RegionNode): RegionPrompt[] {
  if (!isAgentStage(node) || !node.graph) return []
  const groups = (node.graph._groups ?? []).map((group, index) => ({
    group, id: String(group.id ?? index), area: group.size[0] * group.size[1],
  })).filter(({ group, area }) => group.size[0] > 0 && group.size[1] > 0 && Number.isFinite(area))
    .sort((a, b) => a.area - b.area || compareId(a.id, b.id))
  const entries: { area: number; value: RegionPrompt }[] = []
  const seen = new Set<string>()
  for (const context of node.graph._nodes ?? []) {
    if ((context.comfyClass ?? context.type) !== 'ComfyTV.AgentContext'
      || context.mode === 2 || context.mode === 4
      || context.widgets?.find((w) => w.name === 'enabled')?.value === false) continue
    const prompt = context.widgets?.find((w) => w.name === 'main_prompt')?.value
    if (typeof prompt !== 'string' || !prompt.trim()) continue
    const owner = groups.find(({ group }) => contains(group, context))
    const id = String(context.id)
    if (!owner || !contains(owner.group, node) || seen.has(id)) continue
    seen.add(id)
    entries.push({ area: owner.area, value: {
      node_id: id, title: String(context.title ?? ''), group_id: owner.id,
      group_title: String(owner.group.title ?? ''), prompt,
    } })
  }
  return entries.sort((a, b) => b.area - a.area || compareId(a.value.group_id, b.value.group_id)
    || compareId(a.value.node_id, b.value.node_id)).map(({ value }) => value)
}

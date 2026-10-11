import { watch } from 'vue'
import { z } from 'zod'
import { apiFetch, apiSend } from '@/api'
import { useProjectStore } from '@/stores/projectStore'
import type { StageState, useStageStore } from '@/stores/stageStore'
import { ensureStageUid } from './stageIdentity'
import { buildRunPrompt } from './stagePromptBuild'
import { collectRegionPrompts } from './agentRegionPrompts'
import type { StageRunController } from './stageRun'

export { isAgentStage } from './agentRegionPrompts'

const Task = z.object({
  id: z.string(), status: z.string(), error: z.string().nullable(),
  ui: z.object({ output: z.array(z.string()), output_id: z.array(z.number()) }).optional(),
})
const Envelope = z.object({ task: Task })
const List = z.object({ tasks: z.array(Task) })

export function createAgentStageRun(opts: {
  node: any; state: StageState; store: ReturnType<typeof useStageStore>; refresh: () => void
}): StageRunController {
  const { node, state, store, refresh } = opts
  const projects = useProjectStore()
  const hooks: Array<() => unknown> = []
  let taskId: string | null = null
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let submitting = false
  let generation = 0

  const apply = (task: z.infer<typeof Task>) => {
    taskId = task.id
    if (task.status === 'queued' || task.status === 'claimed') {
      state.running = true
      state.error = null
      state.progress = { value: 0, max: 1, text: task.status === 'queued' ? '等待外部 Codex 领取' : '外部 Codex 正在执行' }
    } else if (task.status === 'completed' && task.ui) {
      store.applyExecutedPayload(state, task.ui)
    } else {
      store.applyExecutionError(state, { message: task.error || '任务已结束', type: 'AgentTask' })
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    if (!disposed) timer = setTimeout(() => void poll(), 2000)
  }
  const poll = async () => {
    if (disposed || submitting) return
    if (node.id == null || Number(node.id) < 0) { schedule(); return }
    const pid = projects.currentProjectId
    const epoch = generation
    try {
      const query = new URLSearchParams({ project_id: pid, stage_uid: ensureStageUid(node) })
      const data = await apiFetch(`/comfytv/agent_tasks?${query}`, List)
      if (disposed || pid !== projects.currentProjectId || epoch !== generation || submitting) return
      const task = data.tasks[0]
      if (task) apply(task)
      if (task && ['queued', 'claimed'].includes(task.status)) schedule()
    } catch {
      if (state.running) state.progress = { value: 0, max: 1, text: '连接中断；等待恢复任务状态' }
      schedule()
    }
  }
  const onRunRequest = async () => {
    if (state.running || submitting) return
    submitting = true
    const epoch = ++generation
    if (timer) clearTimeout(timer)
    try {
      for (const fn of hooks) await fn()
      refresh()
      const built = await buildRunPrompt(node, store)
      if (!built) return
      const data = await apiSend('/comfytv/agent_tasks', 'POST', Envelope, {
        project_id: built.pid, stage_uid: ensureStageUid(node), stage_node_id: String(node.id),
        stage_class: node.comfyClass, title: node.title, inputs: built.pm.output[built.targetId].inputs,
        region_prompts: collectRegionPrompts(node),
      })
      if (!disposed && epoch === generation) { apply(data.task); schedule() }
    } catch (error) {
      store.applyExecutionError(state, { message: String(error), type: 'AgentTask' })
    } finally { submitting = false }
  }
  const onCancelRequest = async () => {
    if (!taskId) return
    const epoch = ++generation
    try {
      const data = await apiSend(`/comfytv/agent_tasks/${taskId}/cancel`, 'POST', Envelope)
      if (!disposed && epoch === generation) apply(data.task)
    } catch (error) {
      store.applyExecutionError(state, { message: String(error), type: 'AgentTask' })
    }
  }
  const stopProjectWatch = watch(() => projects.currentProjectId, () => {
    generation++
    taskId = null
    state.running = false
    state.progress = null
    state.error = null
    if (timer) clearTimeout(timer)
    schedule()
  })
  queueMicrotask(() => void poll())
  return {
    onRunRequest, onCancelRequest,
    registerPreRun(fn) { hooks.push(fn); return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1) } },
    dispose() { disposed = true; stopProjectWatch(); if (timer) clearTimeout(timer) },
  }
}

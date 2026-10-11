from ...storage import agent_tasks


async def _list(args):
    return {"tasks": agent_tasks.list_tasks(**args)}


async def _claim(args):
    return {"task": agent_tasks.claim(args['task_id'], args['worker'])}


async def _complete(args):
    return {"task": agent_tasks.finish(args['task_id'], args['claim_token'],
            output_file=args.get('output_file'), text=args.get('text'), attachments=args.get('attachments'))}


async def _fail(args):
    return {"task": agent_tasks.finish(args['task_id'], args['claim_token'], error=args['error'])}


def _tool(description, properties, required, handler):
    return {"description": description, "inputSchema": {"type": "object", "properties": {
        k: {"type": "string"} for k in properties}, "required": required, "additionalProperties": False}, "handler": handler}


TOOLS = {
    "agent_tasks": _tool("列出外部 Codex Stage 任务及完整提示词、上游文件快照。status=queued 是需要你行动的任务。先 agent_claim 再使用自己的工具执行；不要把普通 ComfyUI 任务重复生成。MCP 本身不会唤醒桌面聊天。",
                         ['project_id', 'stage_uid', 'status', 'task_id'], [], _list),
    "agent_claim": _tool("原子领取一个 queued 任务，返回 claim_token。领取成功才可行动；领取失败不要重复付费调用。崩溃后先检查云端任务，使用 cancel_stage 取消旧任务再显式重新运行，不自动重试收费任务。",
                         ['task_id', 'worker'], ['task_id', 'worker'], _claim),
    "agent_complete": _tool("完成已领取任务并将文件写入 Stage 历史与预览。图片/模型/视频提供 input/output 内的绝对 output_file；文本提供 text。附加 blend、FBX、报告用 attachments。重复提交幂等，取消后的结果拒绝。",
                            ['task_id', 'claim_token', 'output_file', 'text'], ['task_id', 'claim_token'], _complete),
    "agent_fail": _tool("记录任务失败原因。不会自动重试或发起付费调用。",
                        ['task_id', 'claim_token', 'error'], ['task_id', 'claim_token', 'error'], _fail),
}
TOOLS['agent_complete']['inputSchema']['properties']['attachments'] = {"type": "array", "items": {"type": "string"}}

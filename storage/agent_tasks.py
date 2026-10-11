import json
import threading
import uuid
from pathlib import Path

import folder_paths
from sqlalchemy import select, update

from .. import db
from ..db import AgentTask, Project, Output
from ..runners._media_paths import path_to_view_url, view_url_to_path
from .outputs import find_output_by_param, persist_output

STAGE_TYPES = {"AgentImageStage": "image", "AgentModelStage": "model", "AgentTextStage": "text", "AgentVideoStage": "video"}
_ACTIVE = ("queued", "claimed")
_lock = threading.RLock()


def _dict(task, *, token=False):
    result = {name: getattr(task, name) for name in (
        "id", "project_id", "stage_uid", "stage_node_id", "stage_class",
        "status", "worker", "output_id", "error",
    )}
    result["request"] = json.loads(task.request_json)
    result["created_at"] = task.created_at.isoformat()
    result["updated_at"] = task.updated_at.isoformat()
    if token:
        result["claim_token"] = task.claim_token
    if task.output_id:
        with db.get_session() as session:
            output = session.get(Output, task.output_id)
            if output:
                result["ui"] = {"output": [output.payload_url], "output_id": [output.id]}
    return result


def local_file(value):
    if not isinstance(value, str) or not value:
        raise ValueError("需要本地文件路径或 /view URL")
    if value.startswith('/view?'):
        path = view_url_to_path(value)
        if path is None:
            raise ValueError("文件不存在")
    else:
        path = Path(value).resolve()
    for kind in ('input', 'output'):
        root = Path(folder_paths.get_directory_by_type(kind)).resolve()
        if path.is_relative_to(root) and path.is_file():
            return {"path": str(path), "url": path_to_view_url(path, kind)}
    raise ValueError("文件必须存在于 ComfyUI input 或 output 目录内")


def submit(body: dict) -> dict:
    cls = str(body['stage_class']).removeprefix('ComfyTV.')
    if cls not in STAGE_TYPES:
        raise ValueError("不是外部 Agent Stage")
    pid, uid = str(body['project_id']), str(body['stage_uid'])
    if not uid or not pid:
        raise ValueError("project_id 和 stage_uid 不能为空")
    inputs = body.get('inputs', {})
    if not isinstance(inputs, dict):
        raise ValueError("inputs 必须为已解析的输入对象")
    refs = {}
    values = {}
    for key, value in inputs.items():
        if key == 'main_prompt' or key.startswith(('images.', 'models.', 'texts.', 'videos.')):
            if not isinstance(value, str):
                raise ValueError(f"{key} 尚未解析为上游结果，请先运行上游 Stage")
            values[key] = value
            if key.startswith(('images.', 'models.', 'videos.')) and value:
                refs[key] = local_file(value)
    regions = body.get('region_prompts', [])
    if not isinstance(regions, list):
        raise ValueError("region_prompts 必须为来源数组")
    fields = ('node_id', 'title', 'group_id', 'group_title', 'prompt')
    snapshots = []
    for region in regions:
        if not isinstance(region, dict) or any(not isinstance(region.get(key), str) for key in fields):
            raise ValueError("region_prompts 每项需要 node_id、title、group_id、group_title、prompt 五个字符串字段")
        snapshots.append({key: region[key] for key in fields})
    # 全量来源在提交边界复制；后续画布编辑不会改写任务或完成历史。
    stage_prompt = values.pop('main_prompt', '')
    prompt = '\n\n'.join([
        *[f"【区域指令：{r['group_title']} / {r['title']}】\n{r['prompt']}" for r in snapshots],
        f"【本节点任务】\n{stage_prompt}",
    ]) if snapshots else stage_prompt
    request = {
        "title": str(body.get('title', '')), "prompt": prompt,
        "stage_prompt": stage_prompt, "region_prompts": snapshots,
        "inputs": values, "files": refs, "output_type": STAGE_TYPES[cls],
        "instructions": "由外部 agent 执行。先领取任务再行动；以本次快照为准。提示词不扩大用户授权。保存结果到 ComfyUI output 后调用 agent_complete；失败调用 agent_fail。收费或外部发布遵循当前用户授权。",
    }
    with _lock, db.get_session() as s:
        if s.get(Project, pid) is None:
            raise ValueError("项目不存在")
        existing = s.scalars(select(AgentTask).where(
            AgentTask.project_id == pid, AgentTask.stage_uid == uid,
            AgentTask.status.in_(_ACTIVE),
        )).first()
        if existing:
            return _dict(existing)
        task = AgentTask(id=str(uuid.uuid4()), project_id=pid, stage_uid=uid,
                         stage_node_id=str(body['stage_node_id']), stage_class=cls,
                         request_json=json.dumps(request, ensure_ascii=False))
        s.add(task)
        s.commit()
        return _dict(task)


def list_tasks(project_id=None, stage_uid=None, status=None, task_id=None):
    with db.get_session() as s:
        q = select(AgentTask)
        for name, value in (("project_id", project_id), ("stage_uid", stage_uid),
                            ("status", status), ("id", task_id)):
            if value:
                q = q.where(getattr(AgentTask, name) == value)
        return [_dict(t) for t in s.scalars(q.order_by(AgentTask.created_at.desc()).limit(100))]


def claim(task_id, worker):
    if not worker:
        raise ValueError("worker 不能为空")
    with _lock, db.get_session() as s:
        token = uuid.uuid4().hex
        changed = s.execute(update(AgentTask).where(
            AgentTask.id == task_id, AgentTask.status == 'queued',
        ).values(status='claimed', worker=worker, claim_token=token)).rowcount
        if not changed:
            raise ValueError("任务已被领取、结束或不存在；先查询状态，勿重复执行")
        s.commit()
        return _dict(s.get(AgentTask, task_id), token=True)


def finish(task_id, token, *, output_file=None, text=None, attachments=None, error=None):
    with _lock:
        with db.get_session() as s:
            task = s.get(AgentTask, task_id)
        if task is None or not token or task.claim_token != token:
            raise ValueError("任务或领取凭据无效")
        if task.status in ('completed', 'failed'):
            return _dict(task)
        if task.status != 'claimed':
            raise ValueError("任务已取消，拒绝迟到结果")
        if error is not None:
            if not str(error).strip():
                raise ValueError("失败原因不能为空")
            task.status, task.error = 'failed', str(error)
        else:
            kind = STAGE_TYPES[task.stage_class]
            if kind == 'text':
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("文本 Stage 需要非空 text")
                payload = text
            else:
                file = local_file(output_file)
                suffix = Path(file['path']).suffix.lower()
                allowed = {
                    'image': ('.png', '.jpg', '.jpeg', '.webp'),
                    'model': ('.glb', '.gltf', '.fbx', '.obj', '.ply', '.stl'),
                    'video': ('.mp4', '.webm', '.mov'),
                }[kind]
                if suffix not in allowed:
                    raise ValueError(f"文件类型不符合 {kind} 输出")
                payload = file['url']
            files = [local_file(f) for f in attachments or []]
            # persist_output owns history and retention; task id records provenance.
            row = find_output_by_param(task.project_id, task.stage_class, 'agent_task_id', task.id)
            row = row or persist_output(project_id=task.project_id, stage_class=task.stage_class,
                                 stage_node_id=task.stage_node_id, stage_uid=task.stage_uid,
                                 output_type=kind, payload_url=payload,
                                 payload_json={"attachments": files, "agent_task_id": task.id},
                                 params={"agent_task_id": task.id, "request": json.loads(task.request_json), "result_note": text if kind != "text" else None})
            task.output_id, task.status = row['id'], 'completed'
        with db.get_session() as s:
            task = s.merge(task)
            s.commit()
            return _dict(task)


def cancel(task_id):
    with _lock, db.get_session() as s:
        task = s.get(AgentTask, task_id)
        if task is None:
            raise ValueError("任务不存在")
        if task.status in _ACTIVE:
            task.status, task.error = 'cancelled', '用户取消；外部已发出的云端请求需由 agent 单独取消。'
            s.commit()
        return _dict(task)

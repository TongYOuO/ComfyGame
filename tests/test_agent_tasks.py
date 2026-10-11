from concurrent.futures import ThreadPoolExecutor

import pytest
from ComfyTV import storage
from ComfyTV.storage import agent_tasks as tasks


@pytest.fixture()
def setup(reset_db, tmp_path, monkeypatch):
    import folder_paths
    root = tmp_path / 'input'
    root.mkdir()
    monkeypatch.setattr(folder_paths, 'get_directory_by_type', lambda kind: str(root) if kind == 'input' else str(tmp_path / kind))
    monkeypatch.setattr('ComfyTV.storage.outputs._warm_output_thumbs', lambda *a: None)
    project = storage.create_project('agent test')
    body = dict(project_id=project['id'], stage_uid='stable-uid', stage_node_id='7',
                stage_class='ComfyTV.AgentImageStage', inputs={'main_prompt': '生成正面'})
    image = root / 'result.png'
    image.write_bytes(b'fixture')
    return body, image


def test_claim_race_and_idempotent_complete(setup):
    body, image = setup
    task = tasks.submit(body)
    assert tasks.submit(body)['id'] == task['id']
    def claim(worker):
        try:
            return tasks.claim(task['id'], worker)
        except ValueError:
            return None
    with ThreadPoolExecutor(2) as pool:
        winners = [r for r in pool.map(claim, ('a', 'b')) if r]
    assert len(winners) == 1
    result = tasks.finish(task['id'], winners[0]['claim_token'], output_file=str(image))
    again = tasks.finish(task['id'], winners[0]['claim_token'], output_file=str(image))
    assert again['output_id'] == result['output_id']
    assert 'claim_token' not in tasks.list_tasks(task_id=task['id'])[0]
    assert tasks.list_tasks(task_id=task['id'])[0]['ui']['output'][0].startswith('/view?')


def test_cancel_rejects_late_result_and_allows_new_run(setup):
    body, image = setup
    task = tasks.submit(body)
    claimed = tasks.claim(task['id'], 'codex')
    tasks.cancel(task['id'])
    with pytest.raises(ValueError, match='取消'):
        tasks.finish(task['id'], claimed['claim_token'], output_file=str(image))
    assert tasks.submit(body)['id'] != task['id']


def test_snapshot_and_path_boundary(setup, tmp_path):
    body, image = setup
    body['inputs']['images.image0'] = tasks.local_file(str(image))['url']
    task = tasks.submit(body)
    assert task['request']['files']['images.image0']['path'] == str(image)
    outside = tmp_path / 'secret.png'
    outside.write_bytes(b'outside')
    with pytest.raises(ValueError):
        tasks.local_file(str(outside))
    with pytest.raises(ValueError):
        tasks.local_file('/view?type=input&filename=../secret.png')
    body['inputs']['images.image0'] = ['3', 0]
    with pytest.raises(ValueError, match='尚未解析'):
        tasks.submit(body)


def test_text_failure_and_persistent_history(setup):
    body, _ = setup
    body['stage_class'] = 'ComfyTV.AgentTextStage'
    task = tasks.submit(body)
    claim = tasks.claim(task['id'], 'codex')
    result = tasks.finish(task['id'], claim['claim_token'], text='已导出 FBX；UE 尚未导入')
    assert result['ui']['output'] == ['已导出 FBX；UE 尚未导入']
    assert storage.latest_output_by_uid(body['project_id'], body['stage_uid'])['id'] == result['output_id']
    other = tasks.submit(body)
    claim = tasks.claim(other['id'], 'codex')
    assert tasks.finish(other['id'], claim['claim_token'], error='缺少 UE 项目')['status'] == 'failed'


def test_project_deletion_removes_tasks(setup):
    body, _ = setup
    task = tasks.submit(body)
    assert storage.delete_project(body['project_id'])
    assert tasks.list_tasks(task_id=task['id']) == []


def test_restart_keeps_claimed_task(setup, reset_db):
    from sqlalchemy.orm import sessionmaker
    body, _ = setup
    task = tasks.submit(body)
    tasks.claim(task['id'], 'codex')
    reset_db._Session = sessionmaker(bind=reset_db._engine, expire_on_commit=False)
    restored = tasks.list_tasks(task_id=task['id'])[0]
    assert restored['status'] == 'claimed'
    assert restored['request']['prompt'] == '生成正面'


@pytest.mark.asyncio
async def test_get_stage_exposes_external_executor_in_its_project(setup, monkeypatch):
    from ComfyTV.api.mcp_tools import stages
    body, _ = setup
    task = tasks.submit(body)
    async def command(*args):
        return {'node_class': 'ComfyTV.AgentImageStage', 'uid': body['stage_uid'],
                'graph_node_id': '7', 'widgets': {'project_id': body['project_id']}}
    monkeypatch.setattr(stages._shared, 'submit_command', command)
    result = await stages._get_stage({'node': '7'})
    assert result['executor'] == 'external-agent'
    assert result['agent_task']['id'] == task['id']
    assert 'agent_claim' in result['next_action']


def test_video_result_and_downstream_snapshot(setup):
    body, image = setup
    video = image.with_suffix('.mp4')
    video.write_bytes(b'video fixture')
    body['stage_class'] = 'ComfyTV.AgentVideoStage'
    task = tasks.submit(body)
    claimed = tasks.claim(task['id'], 'codex')
    with pytest.raises(ValueError, match='video'):
        tasks.finish(task['id'], claimed['claim_token'], output_file=str(image))
    result = tasks.finish(task['id'], claimed['claim_token'], output_file=str(video), text='真实动作渲染')
    body['stage_uid'] = 'downstream'
    body['stage_class'] = 'ComfyTV.AgentTextStage'
    body['inputs']['videos.video0'] = result['ui']['output'][0]
    downstream = tasks.submit(body)
    assert downstream['request']['files']['videos.video0']['path'] == str(video)


def test_region_snapshot_keeps_full_sources_stage_prompt_and_history(setup):
    body, image = setup
    original = '区域规范\n' * 5000
    body['inputs']['main_prompt'] = '节点任务\n' * 4000
    body['region_prompts'] = [
        dict(node_id='1', title='外层规范', group_id='g1', group_title='整体', prompt=original),
        dict(node_id='2', title='内层规范', group_id='g2', group_title='模型', prompt='保留材质'),
    ]
    task = tasks.submit(body)
    request = task['request']
    assert request['stage_prompt'] == body['inputs']['main_prompt']
    assert request['region_prompts'] == body['region_prompts']
    assert request['prompt'] == (
        f'【区域指令：整体 / 外层规范】\n{original}\n\n'
        '【区域指令：模型 / 内层规范】\n保留材质\n\n'
        f"【本节点任务】\n{body['inputs']['main_prompt']}"
    )
    body['region_prompts'][0]['prompt'] = '后来改规则'
    body['region_prompts'][1]['group_title'] = '后来改名'
    body['inputs']['main_prompt'] = '后来改任务'
    assert tasks.submit(body)['request'] == request
    assert tasks.list_tasks(task_id=task['id'])[0]['request'] == request
    claimed = tasks.claim(task['id'], 'codex')
    result = tasks.finish(task['id'], claimed['claim_token'], output_file=str(image))
    history = storage.latest_output_by_uid(body['project_id'], body['stage_uid'])
    assert history['id'] == result['output_id']
    assert history['params_json']['request'] == request
    assert tasks.list_tasks(task_id=task['id'])[0]['request'] == request


@pytest.mark.parametrize('regions', [None, {}, '规则', [None], [{'prompt': '缺字段'}], [
    dict(node_id=1, title='规范', group_id='g', group_title='整体', prompt='规则'),
]])
def test_rejects_invalid_region_sources(setup, regions):
    body, _ = setup
    body['region_prompts'] = regions
    with pytest.raises(ValueError, match='region_prompts'):
        tasks.submit(body)


@pytest.mark.parametrize('regions', [None, []])
def test_legacy_prompt_is_unchanged_without_regions(setup, regions):
    body, _ = setup
    prompt = '  原文\n' * 5000
    body['inputs']['main_prompt'] = prompt
    if regions is not None:
        body['region_prompts'] = regions
    request = tasks.submit(body)['request']
    assert request['prompt'] == request['stage_prompt'] == prompt
    assert request['region_prompts'] == []


def test_context_is_registered_without_stage_metadata_or_ports():
    from ComfyTV.nodes.stages import stage_classes
    from ComfyTV.nodes.stages.common.meta import NON_STAGE_NODES, STAGE_META
    from ComfyTV.nodes.stages.external_agent import AgentContext
    assert AgentContext in stage_classes()
    assert 'AgentContext' in NON_STAGE_NODES
    assert 'AgentContext' not in STAGE_META
    schema = AgentContext.define_schema().kw
    assert schema['outputs'] == []
    assert not schema.get('is_output_node', False)
    prompt, enabled = schema['inputs']
    assert prompt.args == ('main_prompt',)
    assert prompt.kw['multiline'] is True
    assert prompt.kw['socketless'] is True
    assert not prompt.kw.get('extra_dict', {}).get('hidden', False)
    assert enabled.args == ('enabled',)
    assert enabled.kw['default'] is True
    assert enabled.kw['socketless'] is True

from aiohttp import web

from ._common import routes
from ..storage import agent_tasks


@routes.post('/comfytv/agent_tasks')
async def submit_task(request):
    try:
        return web.json_response({"task": agent_tasks.submit(await request.json())})
    except (ValueError, KeyError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)


@routes.get('/comfytv/agent_tasks')
async def list_tasks(request):
    return web.json_response({"tasks": agent_tasks.list_tasks(**{
        k: request.query.get(k) for k in ('project_id', 'stage_uid', 'status', 'task_id')
    })})


@routes.post('/comfytv/agent_tasks/{task_id}/cancel')
async def cancel_task(request):
    try:
        return web.json_response({"task": agent_tasks.cancel(request.match_info['task_id'])})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

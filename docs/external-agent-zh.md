# 外部 Codex Stage（本地扩展）

这版让 ComfyTV 管提示词、连线、任务状态、历史和预览，外部 Codex 决定如何调用图像工具、Tripo/Rodin、Blender 或 UE。ComfyUI 核心未修改，节点自身不调用云端、不保存服务凭据。

## 使用

1. 保持 ComfyUI 与 ComfyTV 页面打开，启用设置中的 MCP。
2. 打开角色流程，图片、模型、视频、文本卡片均可编辑中文提示词与输入连线。
3. 点击**卡片内运行**。外部 Agent Stage 不使用顶部 ComfyUI 整图推理队列；卡片显示「等待外部 Codex 领取」。
4. 在已连接 ComfyTV MCP 的 Codex 中说「读取当前 ComfyTV Stage，执行我指定的任务，并回填结果」。Codex 用 `get_canvas` / `get_stage` 读取图，再用 `agent_tasks` 找任务。
5. `agent_claim` 成功后，按返回的不可变提示词与文件快照执行。图片/模型/视频存到 ComfyUI input/output 目录，用 `agent_complete` 回填；文本用 `text`，额外 .blend/FBX/报告用 `attachments`。失败用 `agent_fail`。
6. 结果会显示在原生卡片、写入历史并作为下游输入。后续 Stage 由 agent 按依赖运行，不自动重复收费。

MCP 地址为 `http://127.0.0.1:8188/comfytv/mcp`，已通过 `codex mcp add comfytv --url ...` 写入当前用户配置。已启动的会话未必热加载新增服务器，可在重新加载工具配置后的会话使用；本次用相同 MCP HTTP 协议做了端到端验证。

**MCP 不会自动唤醒一个已经结束的 Codex 桌面聊天。** 本版需要用户启动一次外部 Codex 执行；未创建后台常驻代理或自动收费执行器。

## 任务协议

- `get_stage` 返回 `executor=external-agent`、当前画布的 `region_prompts`、最新 `agent_task` 和下一步提示；画布镜像也显示当前区域来源。
- `agent_tasks` 可按 project_id、stage_uid、status、task_id 查询，完整提示词不截断。
- queued → claimed → completed / failed；用户可在卡片取消 queued/claimed 任务。
- 重复点击运行复用活跃任务；原子领取仅允许一个执行者；已完成的重复提交返回同一输出。
- 取消后的回填拒绝。取消本地 Stage 不会替你撤销已发出的云端请求。
- 任务和结果存数据库，刷新/重启可恢复。领取凭据丢失时先检查外部执行情况，再取消旧任务并重新运行；不自动恢复可能重复扣费的工作。
- 提示词/连线修改后，要显式重跑对应阶段；历史属于旧快照，不会自动宣称是新角色产物。
- 文件路径验证限制在真实 input/output 目录内；不下载任意远程 URL。

## 区域提示词

从 `ComfyTV/Agent` 添加「区域提示词」（`ComfyTV.AgentContext`），编辑原生多行文本并打开 `enabled`，再将其放入原生组。此节点没有端口、Stage 卡片或运行按钮。普通便签和组标题只作标注，不会成为指令；本地 Qwen 等原生 Stage 不读取区域指令。

按节点中心判断归属，组边界也算内部；提示词只属于包含其中心的最小正面积组，同面积按组 id（无 id 用画布组序号）选择。只有中心也在这个组内的外部图片、模型、文本、视频 Agent Stage 才生效。因此内层规范不会泄漏到外层，外层规范可以作用于内部 Stage。空白、禁用、静音和旁路提示词忽略；无组时不生效。同一节点只收集一次，不同节点的相同文本仍保留。顺序为组面积从大到小，再按组 id、提示词节点 id 排序。

点击卡片运行时，全量原文与节点/组来源写入本地任务 `request.region_prompts`；`stage_prompt` 保留本节点原文，`prompt` 是区域指令在前、本节点任务在后的实际派发文本。没有区域指令时 `prompt` 与旧协议完全一致。完成历史保存同一份 request。`get_stage.region_prompts` 和镜像是当前配置，`agent_task.request.region_prompts` 是那次派发的快照；修改或移动节点不会改写旧任务，活跃任务会继续复用旧快照。完整任务文本不从镜像的截断提示词恢复。

区域提示词不扩大用户授权，也不会自动唤醒 Codex 或自动执行收费步骤；仍需用户启动外部 Agent 并领取任务。

## 角色流程

主形象 → 五部件各四张独立图片 → 五部件 GLB → Blender 拼接与拓扑 → Tripo 贴图 → 骨骼绑定 → 中文文本动作 → Blender 权重检查 → 动作整理 → MP4 预览 → 交付报告。不执行 UE 导入。

五部件是头发、带肤色贴图的素体、裙子、无发头部、鞋子。多视图顺序为正面、背面、左侧、右侧，agent 必须映射到服务的实际字段。

`AgentVideoStage` 支持 MP4/WebM/MOV 回填和视频输入快照。模型预览支持动作选择、播放/暂停、时间拖动、骨架显示与单骨骼权重热图（蓝 0 → 红 1），复用现有 Three.js 查看器，不新增依赖。

`模型到动作_全流程.json` 是本机实际结果；`模型到动作_空结果模板.json` 使用全新 Stage 标识，没有历史结果或旧角色回退输入。先替换主图，再由 Codex 按依赖执行。模板不保证任意角色无需拓扑、绑定和穿插修正。

2026-10-03 实际新增 Tripo 4K 贴图、Mixamo 绑定及约五秒转头挥手动作，合计 60 积分。20 张图、五个部件模型与拼接复用此前成果。新贴图有黑块，静态 GLB 导出骨架矩阵异常；有效服务端动画 GLB 已获取并回填。最终把新动作重定向到同一角色此前修好的几何和材质，两个来源在演示节点中显式连接。不是从另一张新主图完成的全新生成测试，也没有将 Studio 登录变成 API 授权。

最终 GLB/FBX 回读通过：82 根骨骼、9 个蒙皮网格、6 张有效图片，无未加权顶点，至多四权重且归一化；视频为 640×720、24 fps、120 帧。详细结果见 ComfyUI `output/comfytv/模型动作全流程_20261003/交付说明.md`。

## 开发

可将本仓库放在 ComfyUI 同级目录，并通过 `ComfyUI/custom_nodes/ComfyTV` 符号链接启用。

前端构建：`npm ci --legacy-peer-deps` 后 `npm run build`。Python 不增加生产依赖，使用 ComfyUI 已有 SQLAlchemy/aiohttp。修改 Python 后重启 ComfyUI；修改前端后构建并刷新页面。

## 本次验证（2026-10-03）

- Python：任务协议、MCP API 与 Stage 注册共 55 项通过；前端接力/恢复及模型预览测试 11 项通过；类型检查与生产构建通过。
- 实际 MCP：完成 36 节点、56 连线的演示画布；模型、图片、视频与报告均已回填。五个建模任务各读取四张图，拼接任务读取五个模型；报告节点读取模型和视频。
- 关闭页面、重启服务后重新打开：结果及 3D 预览恢复。
- 空结果模板实际打开后，Stage 无旧任务或输出；无上游结果时不能提交模型任务。
- 现有成果工作流与空模板均保存在 ComfyUI `user/default/workflows`，仓库 `examples/character-agent` 留有副本。历史存于本地 ComfyTV 数据库，JSON 本身不包含模型文件或完整历史，跨机器搬迁需一起迁移素材和数据库。

## 三视图美术全流程模板

`ComfyTV_美术全流程_三视图_拼接UV贴图_绑骨动作.json` 是新建的 34 节点、56 连线模板，已在页面加载并核对依赖；尚未用此模板重新生成整批资产。

主图 → 五部件各正/背/左三张独立图片（15 张）→ 五部件模型 → Blender 拼接与拓扑 → Tripo Smart UV → UV 布局/棋盘格检查 → Tripo 贴图 → Blender 材质修复/必要时烘焙 → 最终 UV 与贴图检查 → Tripo 绑定 → Blender 权重修正 → Tripo 动作 → Blender 动作重定向/整理 → MP4 → 交付。旧四视图成果保留。

拆图已修正为15个原生 ImageEditStage，直接调用原五部件20图工作流提取的本地Qwen21单图分支（768、20步），不进入Agent任务队列。UV改为Tripo Smart UV，外部Codex负责该服务操作，Blender不替代展开。Blender操作阶段目前仍保留外部执行方式，是否改为固定本地节点等待用户确认。检查图作为下游真实输入依赖；检查是否合格由执行者判断，不是连线自动评定。服务若改变 UV，材质节点同时读取原 UV 模型和新贴图模型并处理转移；动作节点同时读取动作源和本轮权重修正角色，不使用旧示例兜底。服务若要求第四张图，需显式补右侧节点，不以左图冒充。

## 可迁移的 v3 发布包

当前推荐模板与恢复说明见 [角色全流程](../examples/character-agent/README.md)。本分支只发布空结果 v3 模板；上文旧演示 JSON 和产物路径属于本地历史记录，不随 Git 发布。原 Qwen21 单图分支及参数绑定已导出到 `workflows/image-edit/character-parts-qwen21*.json`，无需上传整个本地数据库。

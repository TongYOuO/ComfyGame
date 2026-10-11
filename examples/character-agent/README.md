# 角色拆分 → 模型 → 绑定与动作

推荐导入 `ComfyTV_角色拆分全流程_可复用模板_v3.json`。这是 47 个节点、82 条连线的空结果模板，保留中文区域提示词和局部修复验收要求。上传自己的主图，并根据角色修改部件描述。示例默认头发、肤色素体、服装、无发头部、鞋子，每部件正／背／左三张独立图；需要右侧时显式添加。

## 恢复环境

1. 将本仓库放进 ComfyUI 的 `custom_nodes`，或在其中建立指向本仓库的链接；已有 ComfyTV 安装时只启用一个副本。重启 ComfyUI。
2. 本分支附带已构建 `js`。自行修改前端时运行 `npm ci --legacy-peer-deps`、`npm run build`。
3. 使用支持 `QwenImage21Cache`、Qwen Image 2.1 的 ComfyUI（本次本地版本 `2d6b7328`）。需本地模型：`diffusion_models/qwen_image_2.1_bf16.safetensors`、`text_encoders/qwen3vl_8b_bf16.safetensors`、`vae/qwen_image_2.1_vae_bf16.safetensors`，自行准备，不随仓库上传。
4. 仓库 `workflows/image-edit/character-parts-qwen21.json` 及配套 `_preset.json` 会通过现有工作流同步机制注册“角色部位拆分 · 原Qwen21单图分支”，包含原 768／20 步配置以及主图、提示词、输出绑定。
5. 导入画布模板，在主图节点换图。打开 ComfyTV 的 MCP；让外部 Codex 通过任务领取、实际执行和结果回填推进 Agent Stage。接口及区域规则见 [使用说明](../../docs/external-agent-zh.md)。

本地 Qwen 固定节点负责拆分图；Tripo 负责多视图模型、Smart UV、贴图、绑定与动作；外部 Codex 负责调用服务、Blender 拼接和有证据的局部审修。节点不自动唤醒 Codex，也不把 Tripo Studio 订阅转换成 API 授权。Tripo 登录／API 凭据、Blender MCP、服务额度需在执行机器配置。

仓库不包含账号凭据、本地运行数据库、生成模型、贴图或历史预览。导入模板不等于恢复旧角色成果，也不保证任意角色无需修复。眼妆、双手、服装接缝及实际 GLB/FBX 的静态和动作近景须逐项检查；没有缺陷则不修改。不自动执行 UE 导入。

提交前检查：65 项 Python 测试、20 项前端测试、类型检查及生产构建通过。此验证针对已有节点与发布包，不是重新付费生成角色。

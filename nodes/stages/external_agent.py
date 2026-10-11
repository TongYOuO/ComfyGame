from comfy_api.latest import io

from .common.inputs import _main_prompt_input, _project_id_input, _parent_output_id_input
from .common.schema import COMFYTV_IMAGE, COMFYTV_MODEL, COMFYTV_TEXT, COMFYTV_VIDEO


class AgentContext(io.ComfyNode):
    """区域指令只由画布派发读取，不参与 Stage 或推理输出。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ComfyTV.AgentContext", display_name="区域提示词",
            category="ComfyTV/Agent",
            inputs=[
                io.String.Input("main_prompt", default="", multiline=True, socketless=True,
                                tooltip="放入原生组；仅作用于该组内的外部 Agent Stage。"),
                io.Boolean.Input("enabled", default=True, socketless=True),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, main_prompt: str = "", enabled: bool = True) -> io.NodeOutput:
        return io.NodeOutput()


class _AgentStage(io.ComfyNode):
    output_type = COMFYTV_IMAGE
    label = "外部 Codex · 图片"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=f"ComfyTV.{cls.__name__}", display_name=cls.label,
            category="ComfyTV/Agent",
            inputs=[
                _project_id_input(), _parent_output_id_input(),
                _main_prompt_input(tooltip="由外部 Codex 领取并执行的中文提示词；点击运行仅提交本地任务。"),
                *[io.Autogrow.Input(name, template=io.Autogrow.TemplatePrefix(
                    kind.Input(prefix, optional=True), prefix=prefix, min=0, max=100,
                )) for name, prefix, kind in (
                    ("texts", "text", COMFYTV_TEXT),
                    ("images", "image", COMFYTV_IMAGE),
                    ("models", "model", COMFYTV_MODEL),
                    ("videos", "video", COMFYTV_VIDEO),
                )],
            ],
            outputs=[cls.output_type.Output("result")], is_output_node=True,
        )

    @classmethod
    def execute(cls, **kwargs):
        raise RuntimeError("请在 ComfyTV Stage 卡片点击运行，再由外部 Codex 领取任务；此节点不在推理队列执行。")


class AgentImageStage(_AgentStage):
    output_type = COMFYTV_IMAGE
    label = "外部 Codex · 图片"


class AgentModelStage(_AgentStage):
    output_type = COMFYTV_MODEL
    label = "外部 Codex · 模型"


class AgentTextStage(_AgentStage):
    output_type = COMFYTV_TEXT
    label = "外部 Codex · 文本/交付"


class AgentVideoStage(_AgentStage):
    output_type = COMFYTV_VIDEO
    label = "外部 Codex · 动作视频"

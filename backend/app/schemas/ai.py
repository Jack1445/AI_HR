from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


DEFAULT_PROMPT = '''请根据提供的本地候选人资料和岗位要求，用中文给出分析：
1. 与岗位相关的技能、项目及经历，并注明资料依据。
2. 契合点和需要进一步确认的信息；没有证据时明确写“资料未提供”。
3. 建议面试时追问的 3 个问题。
如附有在线简历截图，请结合图片内容分析；无法辨认的内容请明确说明。
仅依据岗位相关能力，不按性别、年龄、照片等个人特征评价。不自动淘汰候选人。'''


class AIConfig(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_url: str = Field(default='https://api.openai.com/v1', max_length=500)
    model: str = Field(default='', max_length=200)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int = Field(default=4096, ge=128, le=65536)
    token_parameter: Literal['max_completion_tokens', 'max_tokens'] = 'max_completion_tokens'
    send_session_id: bool = False
    timeout_seconds: int = Field(default=120, ge=15, le=600)
    prompt: str = Field(default=DEFAULT_PROMPT, max_length=20000)

    @field_validator('base_url')
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip().rstrip('/')
        if value.endswith('/chat/completions'):
            value = value[:-len('/chat/completions')]
        elif value.endswith('/models'):
            value = value[:-len('/models')]
        url = urlsplit(value)
        if not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('请填写不含密钥、查询参数的 API 基础地址')
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in {'localhost', '127.0.0.1', '::1'}):
            raise ValueError('API 地址须使用 HTTPS；本机模型可使用 HTTP')
        return value + '/v1' if not url.path else value

    @field_validator('model', 'prompt')
    @classmethod
    def trim(cls, value: str) -> str:
        return value.strip()


class AIConfigSave(AIConfig):
    api_key: SecretStr | None = None
    clear_key: bool = False


class AIJobPromptSave(BaseModel):
    model_config = ConfigDict(extra='forbid')
    prompt: str | None = Field(default=None, min_length=1, max_length=20000)
    jd: str | None = Field(default=None, max_length=10000)

    @field_validator('prompt')
    @classmethod
    def trim_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError('打分标准不能为空')
        return value

    @field_validator('jd')
    @classmethod
    def trim_jd(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class AISelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source: Literal['recommendations', 'communications']
    job_id: str = Field(default='', max_length=64)
    candidate_ids: list[str] = Field(min_length=1, max_length=20)
    include_images: bool = False
    job_context: str = Field(default='', max_length=10000)

    @field_validator('candidate_ids')
    @classmethod
    def unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value) or any(not x or len(x) > 64 for x in value):
            raise ValueError('候选人编号不能重复或无效')
        return value

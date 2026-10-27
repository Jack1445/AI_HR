from pydantic import BaseModel, Field


class JobStats(BaseModel):
    viewed: int = Field(ge=0)
    chatted: int = Field(ge=0)
    interested: int = Field(ge=0)


class Job(BaseModel):
    id: str
    title: str
    status: str
    label: str
    meta: list[str]
    stats: JobStats


class JobListResponse(BaseModel):
    jobs: list[Job]
    remote_total: int | None = None
    source: str = "boss positions"
    read_only: bool = True


class Candidate(BaseModel):
    name: str
    job: str
    time: str
    message: str
    unread_count: int = Field(ge=0)
    source_id: str = ""
    legacy_match_unique: bool = True


class CandidateListResponse(BaseModel):
    job_id: str
    job_title: str
    candidates: list[Candidate]
    remote_total: int | None = None
    unread_total: int | None = None
    source: str = "boss list"
    semantics: str = "已建立沟通且来源岗位文本匹配的候选人"
    read_only: bool = True

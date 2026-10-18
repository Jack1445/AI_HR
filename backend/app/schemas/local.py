from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class SyncResponse(BaseModel):
    sync_id: str
    scope: str
    status: str
    records_seen: int = 0
    records_written: int = 0
    error_summary: str = ""


class LocalJob(BaseModel):
    id: str
    remote_id: str
    title: str
    status: str
    label: str
    meta: list[str]
    stats: dict[str, int]
    updated_at: datetime


class LocalJobListResponse(BaseModel):
    jobs: list[LocalJob]
    total: int


class LocalCandidate(BaseModel):
    id: str
    remote_id: str
    name: str
    stage: str
    owner: str
    favorite: bool
    follow_up_at: datetime | None
    job_ids: list[str] = []
    job_titles: list[str] = []
    latest_message: str = ""
    latest_time: str = ""
    unread_count: int = 0
    tags: list[str] = []
    updated_at: datetime


class LocalCandidateListResponse(BaseModel):
    candidates: list[LocalCandidate]
    total: int


class CandidateUpdate(BaseModel):
    stage: str | None = Field(default=None, pattern="^(new|contacted|communicating|interview_pending|interviewing|decision|offer|hired|rejected|archived)$")
    owner: str | None = None
    favorite: bool | None = None
    follow_up_at: datetime | None = None
    reason: str = ""


class NoteCreate(BaseModel):
    content: str = Field(min_length=1, max_length=10000)
    author: str = Field(default="local", max_length=128)


class TagUpdate(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=30)


class CandidateDetail(LocalCandidate):
    profile: dict[str, Any] = {}
    notes: list[dict[str, Any]] = []
    stage_history: list[dict[str, Any]] = []
    timeline: list[dict[str, Any]] = []


class MatchRequest(BaseModel):
    job_id: str
    force: bool = False


class MatchResult(BaseModel):
    analysis_id: str
    candidate_id: str
    job_id: str
    provider: str
    model: str
    score: int = Field(ge=0, le=100)
    recommendation: str
    must_haves: list[dict[str, Any]]
    strengths: list[str]
    risks: list[str]
    questions: list[str]
    evidence: list[dict[str, Any]]
    generated_at: datetime


class ActionCreate(BaseModel):
    action_type: str = Field(pattern="^(send_message|candidate_stage|boss_action)$")
    candidate_id: str
    job_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)


class ActionResponse(BaseModel):
    id: str
    action_type: str
    status: str
    candidate_id: str
    job_id: str | None
    payload: dict[str, Any]
    result: dict[str, Any]
    created_by: str
    confirmed_by: str
    created_at: datetime
    updated_at: datetime


class TimelineEvent(BaseModel):
    id: str
    event_type: str
    title: str
    content: str
    event_at: datetime
    actor: str


class FunnelResponse(BaseModel):
    job_id: str | None
    counts: dict[str, int]
    total: int


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    content: str = Field(min_length=1, max_length=10000)


class ResumeResponse(BaseModel):
    id: str
    candidate_id: str
    original_name: str
    content_type: str
    size_bytes: int
    sha256: str
    extracted_text: str
    structured: dict[str, Any]
    parser_version: str
    status: str
    created_at: datetime


class AgentTaskCreate(BaseModel):
    task_type: str = Field(pattern="^(daily_suggestions|sync|match_batch)$")
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentTaskResponse(BaseModel):
    id: str
    task_type: str
    status: str
    payload: dict[str, Any]
    result: dict[str, Any]
    error_summary: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

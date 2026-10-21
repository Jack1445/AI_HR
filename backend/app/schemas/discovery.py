from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


CommunicationStatus = Literal['unknown', 'outgoing', 'incoming', 'mutual']


class CommunicationEvidence(BaseModel):
    recruiter_sent: bool
    candidate_sent: bool
    request_resume_enabled: bool | None
    mutual_reply_required: bool
    attachment_present: bool


class CommunicationResult(BaseModel):
    id: str
    status: CommunicationStatus
    evidence: CommunicationEvidence | None = None
    message: str = ''
    time: str = ''
    checked_at: datetime
    error: str = ''


class CommunicationSnapshot(BaseModel):
    version: Literal[1]
    results: list[CommunicationResult] = Field(max_length=10)


class ClassifyRequest(BaseModel):
    candidate_ids: list[str] = Field(min_length=1, max_length=10)


class OnlineResumeScreenshot(BaseModel):
    id: str
    image_url: str
    captured_at: datetime


class CaptureRecommendedResumeRequest(BaseModel):
    geek_id: str = Field(min_length=1, max_length=255)
    candidate_id: str | None = None


class ResumeCaptureResult(BaseModel):
    version: Literal[1]
    geek_id: str
    name: str
    captured_at: datetime


class RecommendedPerson(BaseModel):
    id: str = ''
    source_job: str = ''
    geekId: str
    name: str = Field(min_length=1)
    salary: str
    baseInfo: str
    expect: str
    experience: str
    advantage: str
    highlights: list[str]
    canGreet: bool
    hasHistoryChat: bool
    hasViewed: bool
    online_resume: OnlineResumeScreenshot | None = None


class RecommendationSnapshot(BaseModel):
    version: Literal[1] = 1
    job_label: str = ''
    limit: int = Field(default=10, ge=1, le=10)
    candidates: list[RecommendedPerson] = Field(default_factory=list, max_length=10)
    captured_at: datetime | None = None
    stop_reason: str = ''


class RecommendationLibrary(RecommendationSnapshot):
    candidates: list[RecommendedPerson] = Field(default_factory=list)


class RecommendationReadResult(RecommendationLibrary):
    added_ids: list[str] = Field(default_factory=list)


class RecycledRecommendation(BaseModel):
    id: str
    name: str
    baseInfo: str


class RecommendationRecycleBin(BaseModel):
    candidates: list[RecycledRecommendation] = Field(default_factory=list)

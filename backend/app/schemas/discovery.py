from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


CommunicationStatus = Literal['unknown', 'outgoing', 'incoming', 'mutual']
RECOMMENDATION_READ_LIMIT = 20


class CommunicationEvidence(BaseModel):
    recruiter_sent: bool
    candidate_sent: bool
    request_resume_enabled: bool | None
    mutual_reply_required: bool
    attachment_present: bool
    pending_attachment_request: bool = False


class CommunicationResult(BaseModel):
    id: str
    status: CommunicationStatus
    evidence: CommunicationEvidence | None = None
    message: str = ''
    time: str = ''
    checked_at: datetime
    error: str = ''
    resume_consent: Literal['none', 'clicked'] = 'none'


class CommunicationSnapshot(BaseModel):
    version: Literal[1]
    results: list[CommunicationResult] = Field(max_length=10)


class ClassifyRequest(BaseModel):
    candidate_ids: list[str] = Field(min_length=1, max_length=10)
    accept_incoming_resumes: bool = False


class AttachmentDownloadRequest(BaseModel):
    candidate_id: str = Field(min_length=1)
    job_id: str = Field(min_length=1)


class AttachmentDownloadReceipt(BaseModel):
    id: str
    candidate_id: str
    original_name: str
    size_bytes: int
    already_saved: bool
    saved_folder: str


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
    job_label: str = ''


class RecommendedPerson(BaseModel):
    greeted: bool = False
    first_retrieved_at: datetime | None = None
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
    # Keep historical 50-person snapshots readable; new reads enforce the current cap in the service.
    limit: int = Field(default=RECOMMENDATION_READ_LIMIT, ge=1, le=50)
    candidates: list[RecommendedPerson] = Field(default_factory=list, max_length=50)
    captured_at: datetime | None = None
    stop_reason: str = ''


class RecommendationLibrary(RecommendationSnapshot):
    job_key: str = ''
    candidates: list[RecommendedPerson] = Field(default_factory=list)


class RecommendationReadResult(RecommendationLibrary):
    added_ids: list[str] = Field(default_factory=list)


class RecycledRecommendation(BaseModel):
    id: str
    name: str
    baseInfo: str
    job_key: str = ''
    scope_label: str = '历史全局排除'


class RecommendationRecycleBin(BaseModel):
    candidates: list[RecycledRecommendation] = Field(default_factory=list)


class RecommendationReadRequest(BaseModel):
    job_key: str = Field(min_length=1, max_length=64)


class RecommendationJobsSnapshot(BaseModel):
    version: Literal[1]
    current_job: str
    jobs: list[str] = Field(min_length=1, max_length=2000)
    captured_at: datetime

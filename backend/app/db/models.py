from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class JobRecord(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    remote_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(64), default="active")
    label: Mapped[str] = mapped_column(String(255), default="")
    meta_json: Mapped[str] = mapped_column(Text, default="[]")
    stats_json: Mapped[str] = mapped_column(Text, default="{}")
    source_snapshot: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class CandidateRecord(Base):
    __tablename__ = "candidates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    remote_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    profile_json: Mapped[str] = mapped_column(Text, default="{}")
    source_snapshot: Mapped[str] = mapped_column(Text, default="{}")
    stage: Mapped[str] = mapped_column(String(64), default="new", index=True)
    owner: Mapped[str] = mapped_column(String(128), default="")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    follow_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RecommendationSnapshotRecord(Base):
    """A separate, bounded cache; recommendation cards never become chat candidates."""
    __tablename__ = 'recommendation_snapshots'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    snapshot_json: Mapped[str] = mapped_column(Text)


class RecommendedResumeRecord(Base):
    __tablename__ = 'recommended_resumes'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    geek_id: Mapped[str] = mapped_column(String(255), index=True)
    name: Mapped[str] = mapped_column(String(255))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class RecommendedCandidateRecord(Base):
    __tablename__ = 'recommended_candidates'
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    identity_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    person_json: Mapped[str] = mapped_column(Text)
    source_job: Mapped[str] = mapped_column(Text, default='')
    screenshot_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RecommendationHiddenRecord(Base):
    __tablename__ = 'recommendation_hidden'
    candidate_id: Mapped[str] = mapped_column(ForeignKey('recommended_candidates.id'), primary_key=True)
    hidden_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RecommendationRecycleRecord(Base):
    """Minimal compound identity retained to exclude deleted recommendations."""
    __tablename__ = 'recommendation_recycle_bin'
    identity_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    base_info: Mapped[str] = mapped_column(Text)


class RecommendationJobRecord(Base):
    __tablename__ = 'recommendation_jobs'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(Text)
    available: Mapped[bool] = mapped_column(Boolean, default=False)


class RecommendationRecycleJobRecord(Base):
    __tablename__ = 'recommendation_recycle_jobs'
    identity_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(64), index=True)


class TableWorkspaceRecord(Base):
    __tablename__ = 'table_workspaces'
    scope: Mapped[str] = mapped_column(String(32), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    config_json: Mapped[str] = mapped_column(Text)


class TableCellRecord(Base):
    __tablename__ = 'table_cells'
    scope: Mapped[str] = mapped_column(String(32), primary_key=True)
    record_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    field_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)


class RecommendationFirstCaptureRecord(Base):
    __tablename__ = 'recommendation_first_captures'
    candidate_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CommunicationRecycleRecord(Base):
    __tablename__ = 'communication_recycle_bin'
    remote_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    source_job: Mapped[str] = mapped_column(Text, default='')


class JobCandidateRecord(Base):
    __tablename__ = "job_candidates"
    __table_args__ = (UniqueConstraint("job_id", "candidate_id", name="uq_job_candidate"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    remote_job_text: Mapped[str] = mapped_column(String(255), default="")
    remote_time: Mapped[str] = mapped_column(String(128), default="")
    last_message: Mapped[str] = mapped_column(Text, default="")
    unread_count: Mapped[int] = mapped_column(Integer, default=0)
    source_snapshot: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class TagRecord(Base):
    __tablename__ = "tags"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class CandidateTagRecord(Base):
    __tablename__ = "candidate_tags"
    __table_args__ = (UniqueConstraint("candidate_id", "tag_id", name="uq_candidate_tag"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id"), index=True)


class CandidateNoteRecord(Base):
    __tablename__ = "candidate_notes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(String(128), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class StageHistoryRecord(Base):
    __tablename__ = "stage_history"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    from_stage: Mapped[str] = mapped_column(String(64), default="")
    to_stage: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(Text, default="")
    actor: Mapped[str] = mapped_column(String(128), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class SyncRunRecord(Base):
    __tablename__ = "sync_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    scope: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    records_seen: Mapped[int] = mapped_column(Integer, default=0)
    records_written: Mapped[int] = mapped_column(Integer, default=0)
    error_summary: Mapped[str] = mapped_column(Text, default="")


class TimelineEventRecord(Base):
    __tablename__ = "timeline_events"
    __table_args__ = (UniqueConstraint("dedupe_key", name="uq_timeline_dedupe"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text, default="")
    event_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    actor: Mapped[str] = mapped_column(String(128), default="system")
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True)


class AIAnalysisRecord(Base):
    __tablename__ = "ai_analyses"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    provider: Mapped[str] = mapped_column(String(64), default="deterministic")
    model: Mapped[str] = mapped_column(String(128), default="rules-v1")
    prompt_version: Mapped[str] = mapped_column(String(64), default="match-v1")
    input_hash: Mapped[str] = mapped_column(String(128), index=True)
    result_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ActionRecord(Base):
    __tablename__ = "actions"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_action_idempotency"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    action_type: Mapped[str] = mapped_column(String(64), index=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(32), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    result_json: Mapped[str] = mapped_column(Text, default="{}")
    created_by: Mapped[str] = mapped_column(String(128), default="local")
    confirmed_by: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ResumeDocumentRecord(Base):
    __tablename__ = "resume_documents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"), index=True)
    original_name: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(String(512), unique=True)
    content_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    extracted_text: Mapped[str] = mapped_column(Text, default="")
    structured_json: Mapped[str] = mapped_column(Text, default="{}")
    parser_version: Mapped[str] = mapped_column(String(64), default="text-v1")
    status: Mapped[str] = mapped_column(String(32), default="parsed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class CommunicationAttachmentRecord(Base):
    __tablename__ = 'communication_attachments'
    __table_args__ = (UniqueConstraint('candidate_id', 'job_id', name='uq_communication_attachment_candidate_job'),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey('candidates.id'), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), index=True)
    resume_id: Mapped[str] = mapped_column(ForeignKey('resume_documents.id'))
    export_path: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AIConnectionRecord(Base):
    __tablename__ = 'ai_connection'
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default='default')
    config_json: Mapped[str] = mapped_column(Text, default='{}')
    encrypted_key: Mapped[str] = mapped_column(Text, default='')


class AIJobPromptRecord(Base):
    __tablename__ = 'ai_job_prompts'
    job_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    prompt: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AIJobJDRecord(Base):
    __tablename__ = 'ai_job_jds'
    job_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    jd: Mapped[str] = mapped_column(Text, default='')
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AIManagedRunRecord(Base):
    __tablename__ = 'ai_managed_runs'
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    status: Mapped[str] = mapped_column(String(32), default='queued', index=True)
    config_json: Mapped[str] = mapped_column(Text)
    selection_json: Mapped[str] = mapped_column(Text)
    items_json: Mapped[str] = mapped_column(Text)
    error: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RecommendationGreetingBatchRecord(Base):
    __tablename__ = 'recommendation_greeting_batches'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_key: Mapped[str] = mapped_column(String(64), index=True)
    job_label: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default='queued', index=True)
    items_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RecommendationGreetingLedgerRecord(Base):
    __tablename__ = 'recommendation_greeting_ledger'
    # Retain only opaque identity and outcome, even if a local candidate is deleted.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    batch_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AgentTaskRecord(Base):
    __tablename__ = "agent_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    task_type: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    result_json: Mapped[str] = mapped_column(Text, default="{}")
    error_summary: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(128), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MessageTemplateRecord(Base):
    __tablename__ = "message_templates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AuditEventRecord(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    actor: Mapped[str] = mapped_column(String(128), default="system")
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(64), default="")
    target_id: Mapped[str] = mapped_column(String(128), default="")
    detail_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)

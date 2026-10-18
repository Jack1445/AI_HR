from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.json_utils import dumps, loads
from app.db.models import (
    AuditEventRecord,
    CandidateNoteRecord,
    CandidateRecord,
    CandidateTagRecord,
    JobCandidateRecord,
    JobRecord,
    StageHistoryRecord,
    SyncRunRecord,
    TagRecord,
    TimelineEventRecord,
)
from app.schemas.local import (
    CandidateDetail,
    CandidateUpdate,
    LocalCandidate,
    LocalCandidateListResponse,
    LocalJob,
    LocalJobListResponse,
    NoteCreate,
    SyncResponse,
    TagUpdate,
)
from app.services.boss_readonly import BossReadOnlyService


STAGES = ("new", "contacted", "communicating", "interview_pending", "interviewing", "decision", "offer", "hired", "rejected", "archived")


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _actor(actor: str | None) -> str:
    return (actor or "local").strip()[:128] or "local"


class LocalStoreService:
    def __init__(self, db: Session, boss: BossReadOnlyService | None = None) -> None:
        self.db = db
        self.boss = boss

    def _audit(self, event_type: str, target_type: str, target_id: str, detail: dict[str, Any], actor: str = "system") -> None:
        self.db.add(AuditEventRecord(actor=_actor(actor), event_type=event_type, target_type=target_type, target_id=target_id, detail_json=dumps(detail)))

    async def sync(self, scope: str = "all") -> SyncResponse:
        if self.boss is None:
            raise RuntimeError("未配置 BOSS 只读服务")
        run = SyncRunRecord(scope=scope, status="running")
        self.db.add(run)
        self.db.commit()
        seen = written = 0
        try:
            remote_jobs = await self.boss.list_jobs()
            for remote in remote_jobs.jobs:
                seen += 1
                job = self.db.scalar(select(JobRecord).where(JobRecord.remote_id == remote.id))
                if job is None:
                    job = JobRecord(remote_id=remote.id, title=remote.title)
                    self.db.add(job)
                    self.db.flush()
                    written += 1
                job.title = remote.title
                job.status = remote.status
                job.label = remote.label
                job.meta_json = dumps(remote.meta)
                job.stats_json = dumps(remote.stats.model_dump())
                job.source_snapshot = dumps(remote.model_dump())
                if scope == "jobs":
                    continue
                candidates = await self.boss.list_candidates_for_job(remote.id)
                for item in candidates.candidates:
                    seen += 1
                    # boss-cli list output currently has no candidate ID. Keep
                    # the fallback key stable when only message/time changes.
                    remote_id = _fingerprint("candidate", item.name.strip().lower(), item.job.strip().lower())
                    candidate = self.db.scalar(select(CandidateRecord).where(CandidateRecord.remote_id == remote_id))
                    if candidate is None:
                        candidate = CandidateRecord(remote_id=remote_id, name=item.name, profile_json="{}")
                        self.db.add(candidate)
                        self.db.flush()
                        written += 1
                    candidate.name = item.name
                    candidate.source_snapshot = dumps(item.model_dump())
                    relation = self.db.scalar(select(JobCandidateRecord).where(JobCandidateRecord.job_id == job.id, JobCandidateRecord.candidate_id == candidate.id))
                    if relation is None:
                        relation = JobCandidateRecord(job_id=job.id, candidate_id=candidate.id)
                        self.db.add(relation)
                    relation.remote_job_text = item.job
                    relation.remote_time = item.time
                    relation.last_message = item.message
                    relation.unread_count = item.unread_count
                    relation.source_snapshot = dumps(item.model_dump())
                    event_key = _fingerprint("remote-message", job.id, candidate.id, item.time, item.message)
                    if self.db.scalar(select(TimelineEventRecord).where(TimelineEventRecord.dedupe_key == event_key)) is None:
                        self.db.add(TimelineEventRecord(candidate_id=candidate.id, job_id=job.id, event_type="message", title="BOSS 沟通记录", content=item.message, actor="boss-cli", dedupe_key=event_key))
            run.status = "success"
            run.records_seen = seen
            run.records_written = written
            run.finished_at = datetime.now(timezone.utc)
            self._audit("sync_completed", "sync_run", run.id, {"scope": scope, "records_seen": seen, "records_written": written})
            self.db.commit()
            return SyncResponse(sync_id=run.id, scope=scope, status=run.status, records_seen=seen, records_written=written)
        except Exception as exc:
            self.db.rollback()
            failed = self.db.get(SyncRunRecord, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.records_seen = seen
                failed.records_written = written
                failed.error_summary = str(exc)[:2000]
                failed.finished_at = datetime.now(timezone.utc)
                self._audit("sync_failed", "sync_run", run.id, {"scope": scope, "error": failed.error_summary})
                self.db.commit()
            raise

    def list_jobs(self) -> LocalJobListResponse:
        rows = self.db.scalars(select(JobRecord).order_by(JobRecord.updated_at.desc())).all()
        return LocalJobListResponse(jobs=[LocalJob(id=r.id, remote_id=r.remote_id, title=r.title, status=r.status, label=r.label, meta=loads(r.meta_json, []), stats=loads(r.stats_json, {}), updated_at=r.updated_at) for r in rows], total=len(rows))

    def list_candidates(self, job_id: str | None = None, stage: str | None = None, tag: str | None = None, q: str | None = None, favorite: bool | None = None, limit: int = 100, offset: int = 0) -> LocalCandidateListResponse:
        stmt = select(CandidateRecord).order_by(CandidateRecord.updated_at.desc()).offset(offset).limit(min(limit, 500))
        if job_id:
            stmt = stmt.join(JobCandidateRecord, JobCandidateRecord.candidate_id == CandidateRecord.id).where(JobCandidateRecord.job_id == job_id)
        if stage:
            stmt = stmt.where(CandidateRecord.stage == stage)
        if favorite is not None:
            stmt = stmt.where(CandidateRecord.favorite == favorite)
        if tag:
            stmt = stmt.join(CandidateTagRecord, CandidateTagRecord.candidate_id == CandidateRecord.id).join(TagRecord, TagRecord.id == CandidateTagRecord.tag_id).where(TagRecord.name == tag)
        if q:
            needle = f"%{q.strip()}%"
            stmt = stmt.where(or_(CandidateRecord.name.ilike(needle), CandidateRecord.owner.ilike(needle)))
        rows = self.db.scalars(stmt).unique().all()
        items = [self._candidate_view(row) for row in rows]
        return LocalCandidateListResponse(candidates=items, total=len(items))

    def list_reminders(self, limit: int = 100) -> LocalCandidateListResponse:
        rows = self.db.scalars(select(CandidateRecord).order_by(CandidateRecord.follow_up_at.asc(), CandidateRecord.updated_at.desc()).limit(min(limit, 500))).all()
        items = [self._candidate_view(row) for row in rows]
        now = datetime.now(timezone.utc)
        def is_due(row: CandidateRecord, item: LocalCandidate) -> bool:
            follow_up = row.follow_up_at
            if follow_up is not None and follow_up.tzinfo is None:
                follow_up = follow_up.replace(tzinfo=timezone.utc)
            return (follow_up is not None and follow_up <= now) or item.unread_count > 0

        due = [item for item, row in zip(items, rows) if is_due(row, item)]
        return LocalCandidateListResponse(candidates=due, total=len(due))

    def _candidate_view(self, row: CandidateRecord) -> LocalCandidate:
        relations = self.db.scalars(select(JobCandidateRecord).where(JobCandidateRecord.candidate_id == row.id).order_by(JobCandidateRecord.updated_at.desc())).all()
        jobs = [self.db.get(JobRecord, relation.job_id) for relation in relations]
        tags = self.db.scalars(select(TagRecord.name).join(CandidateTagRecord, CandidateTagRecord.tag_id == TagRecord.id).where(CandidateTagRecord.candidate_id == row.id)).all()
        latest = relations[0] if relations else None
        return LocalCandidate(id=row.id, remote_id=row.remote_id, name=row.name, stage=row.stage, owner=row.owner, favorite=row.favorite, follow_up_at=row.follow_up_at, job_ids=[job.id for job in jobs if job], job_titles=[job.title for job in jobs if job], latest_message=latest.last_message if latest else "", latest_time=latest.remote_time if latest else "", unread_count=latest.unread_count if latest else 0, tags=list(tags), updated_at=row.updated_at)

    def detail(self, candidate_id: str) -> CandidateDetail:
        row = self.db.get(CandidateRecord, candidate_id)
        if row is None:
            raise LookupError("未找到候选人")
        view = self._candidate_view(row)
        notes = self.db.scalars(select(CandidateNoteRecord).where(CandidateNoteRecord.candidate_id == candidate_id).order_by(CandidateNoteRecord.created_at.desc())).all()
        history = self.db.scalars(select(StageHistoryRecord).where(StageHistoryRecord.candidate_id == candidate_id).order_by(StageHistoryRecord.created_at.desc())).all()
        timeline = self.db.scalars(select(TimelineEventRecord).where(TimelineEventRecord.candidate_id == candidate_id).order_by(TimelineEventRecord.event_at.desc())).all()
        return CandidateDetail(**view.model_dump(), profile=loads(row.profile_json, {}), notes=[{"id": n.id, "content": n.content, "author": n.author, "created_at": n.created_at} for n in notes], stage_history=[{"id": h.id, "from_stage": h.from_stage, "to_stage": h.to_stage, "reason": h.reason, "actor": h.actor, "created_at": h.created_at} for h in history], timeline=[{"id": e.id, "event_type": e.event_type, "title": e.title, "content": e.content, "event_at": e.event_at, "actor": e.actor} for e in timeline])

    def update_candidate(self, candidate_id: str, payload: CandidateUpdate, actor: str = "local") -> CandidateDetail:
        row = self.db.get(CandidateRecord, candidate_id)
        if row is None:
            raise LookupError("未找到候选人")
        if payload.stage and payload.stage != row.stage:
            self.db.add(StageHistoryRecord(candidate_id=row.id, from_stage=row.stage, to_stage=payload.stage, reason=payload.reason, actor=_actor(actor)))
            self.db.add(TimelineEventRecord(candidate_id=row.id, event_type="stage", title=f"阶段变更为 {payload.stage}", content=payload.reason, actor=_actor(actor), dedupe_key=_fingerprint("stage", row.id, row.stage, payload.stage, datetime.now(timezone.utc).isoformat())))
            row.stage = payload.stage
        if payload.owner is not None:
            row.owner = payload.owner.strip()[:128]
        if payload.favorite is not None:
            row.favorite = payload.favorite
        if payload.follow_up_at is not None:
            row.follow_up_at = payload.follow_up_at
        self._audit("candidate_updated", "candidate", row.id, payload.model_dump(exclude_none=True), actor)
        self.db.commit()
        return self.detail(row.id)

    def add_note(self, candidate_id: str, payload: NoteCreate) -> CandidateDetail:
        if self.db.get(CandidateRecord, candidate_id) is None:
            raise LookupError("未找到候选人")
        self.db.add(CandidateNoteRecord(candidate_id=candidate_id, content=payload.content, author=_actor(payload.author)))
        self.db.add(TimelineEventRecord(candidate_id=candidate_id, event_type="note", title="新增备注", content=payload.content, actor=_actor(payload.author), dedupe_key=_fingerprint("note", candidate_id, payload.content, datetime.now(timezone.utc).isoformat())))
        self._audit("note_created", "candidate", candidate_id, {"content_length": len(payload.content)}, payload.author)
        self.db.commit()
        return self.detail(candidate_id)

    def update_tags(self, candidate_id: str, payload: TagUpdate) -> CandidateDetail:
        if self.db.get(CandidateRecord, candidate_id) is None:
            raise LookupError("未找到候选人")
        existing = self.db.scalars(select(CandidateTagRecord).where(CandidateTagRecord.candidate_id == candidate_id)).all()
        for link in existing:
            self.db.delete(link)
        for raw_name in payload.tags:
            name = raw_name.strip()[:64]
            if not name:
                continue
            tag = self.db.scalar(select(TagRecord).where(TagRecord.name == name))
            if tag is None:
                tag = TagRecord(name=name)
                self.db.add(tag)
                self.db.flush()
            self.db.add(CandidateTagRecord(candidate_id=candidate_id, tag_id=tag.id))
        self._audit("tags_updated", "candidate", candidate_id, {"tags": payload.tags})
        self.db.commit()
        return self.detail(candidate_id)

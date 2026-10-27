from __future__ import annotations

import hashlib
import logging
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.json_utils import dumps, loads
from app.db.errors import database_error_summary
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
    CommunicationRecycleRecord,
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
from app.services.diagnostics import DiagnosticLog


STAGES = ("new", "contacted", "communicating", "interview_pending", "interviewing", "decision", "offer", "hired", "rejected", "archived")
LOGGER = logging.getLogger(__name__)


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _actor(actor: str | None) -> str:
    return (actor or "local").strip()[:128] or "local"


class LocalStoreService:
    def __init__(self, db: Session, boss: BossReadOnlyService | None = None) -> None:
        self.db = db
        self.boss = boss
        self.diagnostic_log_path: str | None = None

    def _audit(self, event_type: str, target_type: str, target_id: str, detail: dict[str, Any], actor: str = "system") -> None:
        self.db.add(AuditEventRecord(actor=_actor(actor), event_type=event_type, target_type=target_type, target_id=target_id, detail_json=dumps(detail)))

    async def sync(self, scope: str = "all", diagnostic: bool = False, since: date | None = None) -> SyncResponse:
        if self.boss is None:
            raise RuntimeError("未配置 BOSS 只读服务")
        diagnostic_log = DiagnosticLog.create()
        self.diagnostic_log_path = str(diagnostic_log.path) if diagnostic_log else None
        if diagnostic_log is not None:
            diagnostic_log.write("sync.start", {"scope": scope, "since": since.isoformat() if since else None, "cwd": str(Path.cwd()), "debug": diagnostic})
        run = SyncRunRecord(scope=scope, status="running")
        self.db.add(run)
        self.db.commit()
        diagnostic_log.write("sync.created", {"sync_id": run.id})
        seen = written = 0
        verification_ids: list[str] = []
        ambiguous_legacy_ids: set[str] = set()
        try:
            phase_start = time.monotonic()
            diagnostic_log.write("sync.jobs_start")
            remote_jobs = await self.boss.list_jobs(
                debug=diagnostic,
                diagnostic_log=diagnostic_log,
            )
            if diagnostic_log is not None:
                diagnostic_log.write("sync.jobs_loaded", {"count": len(remote_jobs.jobs), "remote_total": remote_jobs.remote_total, "elapsed_seconds": time.monotonic() - phase_start})
            candidates_by_job = {}
            if scope != "jobs":
                phase_start = time.monotonic()
                diagnostic_log.write("sync.candidates_start")
                candidates_by_job = await self.boss.list_candidates_for_jobs(
                    remote_jobs.jobs, debug=diagnostic, diagnostic_log=diagnostic_log, history=True, since=since
                )
                diagnostic_log.write("sync.candidates_complete", {"elapsed_seconds": time.monotonic() - phase_start})
            phase_start = time.monotonic()
            diagnostic_log.write("sync.database_start")
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
                candidates = candidates_by_job[remote.id]
                if diagnostic_log is not None:
                    diagnostic_log.write("sync.candidates_loaded", {"job_id": remote.id, "count": len(candidates.candidates)})
                for item in candidates.candidates:
                    seen += 1
                    legacy_id = _fingerprint("candidate", item.name.strip().lower(), item.job.strip().lower())
                    remote_id = _fingerprint("boss-chat", item.source_id) if item.source_id else legacy_id
                    # Existing tombstones retain their original exclusion scope.
                    if self.db.get(CommunicationRecycleRecord, remote_id) is not None or self.db.get(CommunicationRecycleRecord, legacy_id) is not None:
                        continue
                    candidate = self.db.scalar(select(CandidateRecord).where(CandidateRecord.remote_id == remote_id))
                    if item.source_id:
                        legacy = self.db.scalar(select(CandidateRecord).where(CandidateRecord.remote_id == legacy_id))
                        if legacy is not None and not loads(legacy.source_snapshot, {}).get('source_id'):
                            if item.legacy_match_unique and candidate is None:
                                # One-time identity upgrade keeps the local ID and all annotations.
                                legacy.remote_id = remote_id
                                candidate = legacy
                            elif not item.legacy_match_unique:
                                source = loads(legacy.source_snapshot, {})
                                source['identity_warning'] = '旧记录仅有姓名和岗位，现有多个同名会话，未将旧标注分配给任意一人；请人工确认历史记录'
                                legacy.source_snapshot = dumps(source)
                                ambiguous_legacy_ids.add(legacy.id)
                    if candidate is None:
                        candidate = CandidateRecord(remote_id=remote_id, name=item.name, profile_json="{}")
                        self.db.add(candidate)
                        self.db.flush()
                        written += 1
                    candidate.name = item.name
                    if candidate.id not in verification_ids:
                        verification_ids.append(candidate.id)
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
                    # Production sessions disable autoflush. Later rows must see
                    # identity upgrades, relations and event keys from this row.
                    # Flush stays inside this transaction; it does not commit.
                    self.db.flush()
            run.status = "success"
            run.records_seen = seen
            run.records_written = written
            run.finished_at = datetime.now(timezone.utc)
            self._audit("sync_completed", "sync_run", run.id, {"scope": scope, "records_seen": seen, "records_written": written})
            self.db.commit()
            diagnostic_log.write("sync.database_complete", {"elapsed_seconds": time.monotonic() - phase_start})
            if diagnostic_log is not None:
                diagnostic_log.write("sync.complete", {"sync_id": run.id, "records_seen": seen, "records_written": written})
            return SyncResponse(sync_id=run.id, scope=scope, status=run.status, records_seen=seen, records_written=written, diagnostic_log=self.diagnostic_log_path, since=since, verification_ids=verification_ids, history_summary={**getattr(self.boss, "history_summary", {}), 'ambiguous_legacy': len(ambiguous_legacy_ids)})
        except Exception as exc:
            self.db.rollback()
            error_summary = database_error_summary(exc) if isinstance(exc, SQLAlchemyError) else f"{type(exc).__name__}: {str(exc).strip() or repr(exc)}"[:2000]
            if diagnostic_log is not None:
                diagnostic_log.write("sync.failed", {"records_seen": seen, "records_written": written, "error": error_summary})
            LOGGER.error(
                "BOSS sync failed: scope=%s records_seen=%s records_written=%s error=%s",
                scope,
                seen,
                written,
                error_summary,
                exc_info=not isinstance(exc, SQLAlchemyError),
            )
            failed = self.db.get(SyncRunRecord, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.records_seen = seen
                failed.records_written = written
                failed.error_summary = error_summary
                failed.finished_at = datetime.now(timezone.utc)
                self._audit("sync_failed", "sync_run", run.id, {"scope": scope, "error": failed.error_summary})
                self.db.commit()
            raise

    def list_jobs(self) -> LocalJobListResponse:
        rows = self.db.scalars(select(JobRecord).order_by(JobRecord.updated_at.desc())).all()
        return LocalJobListResponse(jobs=[LocalJob(id=r.id, remote_id=r.remote_id, title=r.title, status=r.status, label=r.label, meta=loads(r.meta_json, []), stats=loads(r.stats_json, {}), updated_at=r.updated_at) for r in rows], total=len(rows))

    def list_candidates(self, job_id: str | None = None, stage: str | None = None, tag: str | None = None, q: str | None = None, favorite: bool | None = None, limit: int = 100, offset: int = 0) -> LocalCandidateListResponse:
        stmt = select(CandidateRecord).order_by(CandidateRecord.created_at.desc(), CandidateRecord.id).offset(offset).limit(min(limit, 500))
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
        total = self.db.scalar(select(func.count()).select_from(stmt.limit(None).offset(None).order_by(None).subquery()))
        rows = self.db.scalars(stmt).unique().all()
        items = [self._candidate_view(row) for row in rows]
        return LocalCandidateListResponse(candidates=items, total=total)

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
        communication = loads(row.profile_json, {}).get('communication', {})
        identity_warning = loads(row.source_snapshot, {}).get('identity_warning', '')
        stale = bool(communication.get('evidence')) and (
            communication.get('message', '') != (latest.last_message if latest else '') or
            communication.get('time', '') != (latest.remote_time if latest else ''))
        # No stable remote message IDs yet: conservatively recheck changed
        # message/time snapshots, even when the displayed time is relative.
        return LocalCandidate(id=row.id, remote_id=row.remote_id, name=row.name, stage=row.stage, owner=row.owner, favorite=row.favorite, follow_up_at=row.follow_up_at, job_ids=[job.id for job in jobs if job], job_titles=[job.title for job in jobs if job], latest_message=latest.last_message if latest else "", latest_time=latest.remote_time if latest else "", unread_count=latest.unread_count if latest else 0, tags=list(tags), updated_at=row.updated_at,
            created_at=row.created_at,
            communication_status='unknown' if stale or identity_warning else communication.get('status', 'unknown'),
            communication_checked_at=communication.get('checked_at'),
            communication_evidence=communication.get('evidence'),
            communication_error=identity_warning or ('消息或时间已变化，请重新核验' if stale else communication.get('error', '')),
            communication_stale=stale)

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

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.json_utils import dumps, loads
from app.db.models import AgentTaskRecord, AuditEventRecord, CandidateRecord, JobCandidateRecord
from app.schemas.local import AgentTaskCreate, AgentTaskResponse
from app.services.local_store import LocalStoreService
from app.services.matching import MatchingService


class AgentTaskService:
    def __init__(self, db: Session, settings: Settings, local: LocalStoreService) -> None:
        self.db = db
        self.settings = settings
        self.local = local

    def _response(self, row: AgentTaskRecord) -> AgentTaskResponse:
        return AgentTaskResponse(id=row.id, task_type=row.task_type, status=row.status, payload=loads(row.payload_json, {}), result=loads(row.result_json, {}), error_summary=row.error_summary, created_at=row.created_at, started_at=row.started_at, finished_at=row.finished_at)

    def _audit(self, row: AgentTaskRecord, event: str, detail: dict[str, Any]) -> None:
        self.db.add(AuditEventRecord(actor=row.created_by, event_type=event, target_type="agent_task", target_id=row.id, detail_json=dumps(detail)))

    async def create_and_run(self, payload: AgentTaskCreate, actor: str = "local") -> AgentTaskResponse:
        row = AgentTaskRecord(task_type=payload.task_type, status="running", payload_json=dumps(payload.payload), created_by=actor[:128] or "local", started_at=datetime.now(timezone.utc))
        self.db.add(row)
        self.db.flush()
        self._audit(row, "agent_task_started", payload.payload)
        self.db.commit()
        try:
            if payload.task_type == "daily_suggestions":
                candidates = self.local.list_candidates(limit=500).candidates
                suggestions = [{"candidate_id": c.id, "candidate": c.name, "reason": "有未读沟通" if c.unread_count else "需要跟进", "job_titles": c.job_titles} for c in candidates if c.unread_count or c.follow_up_at is not None][:100]
                result = {"suggestions": suggestions, "count": len(suggestions), "writes_executed": 0}
            elif payload.task_type == "sync":
                sync_result = await self.local.sync(str(payload.payload.get("scope", "all")))
                result = sync_result.model_dump()
            else:
                candidate_ids = payload.payload.get("candidate_ids", [])
                job_id = str(payload.payload.get("job_id", ""))
                result_items = []
                for candidate_id in candidate_ids[:50]:
                    result_items.append(MatchingService(self.db).analyze(str(candidate_id), job_id).model_dump(mode="json"))
                result = {"analyses": result_items, "count": len(result_items)}
            row.status = "success"
            row.result_json = dumps(result)
        except Exception as exc:
            self.db.rollback()
            row = self.db.get(AgentTaskRecord, row.id) or row
            row.status = "failed"
            row.error_summary = str(exc)[:2000]
        row.finished_at = datetime.now(timezone.utc)
        self._audit(row, "agent_task_finished", {"status": row.status})
        self.db.commit()
        self.db.refresh(row)
        return self._response(row)

    def list(self, limit: int = 100) -> list[AgentTaskResponse]:
        rows = self.db.scalars(select(AgentTaskRecord).order_by(AgentTaskRecord.created_at.desc()).limit(min(limit, 500))).all()
        return [self._response(row) for row in rows]

    def get(self, task_id: str) -> AgentTaskResponse:
        row = self.db.get(AgentTaskRecord, task_id)
        if row is None:
            raise LookupError("未找到 Agent 任务")
        return self._response(row)

    def cancel(self, task_id: str) -> AgentTaskResponse:
        row = self.db.get(AgentTaskRecord, task_id)
        if row is None:
            raise LookupError("未找到 Agent 任务")
        if row.status in {"running", "queued"}:
            row.status = "cancelled"
            row.finished_at = datetime.now(timezone.utc)
            self.db.commit()
        return self._response(row)

    async def retry(self, task_id: str, actor: str = "local") -> AgentTaskResponse:
        row = self.db.get(AgentTaskRecord, task_id)
        if row is None:
            raise LookupError("未找到 Agent 任务")
        if row.status != "failed":
            raise ValueError("只有失败任务可以重试")
        payload = AgentTaskCreate(task_type=row.task_type, payload=loads(row.payload_json, {}))
        return await self.create_and_run(payload, actor)

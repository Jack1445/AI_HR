from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.boss_cli import BossCliAdapter
from app.core.config import Settings
from app.core.json_utils import dumps, loads
from app.db.models import ActionRecord, AuditEventRecord, CandidateRecord, JobRecord
from app.schemas.local import ActionCreate, ActionResponse
from app.services.local_store import STAGES


ALLOWED_BOSS_ACTIONS = {"resume", "not-fit", "remark", "agree-resume", "request-attachment-resume", "history", "wechat"}


class ActionService:
    def __init__(self, db: Session, settings: Settings, adapter: BossCliAdapter | None = None) -> None:
        self.db = db
        self.settings = settings
        self.adapter = adapter

    def _audit(self, event_type: str, action_id: str, detail: dict[str, Any], actor: str) -> None:
        self.db.add(AuditEventRecord(actor=actor[:128] or "local", event_type=event_type, target_type="action", target_id=action_id, detail_json=dumps(detail)))

    def _response(self, row: ActionRecord) -> ActionResponse:
        return ActionResponse(id=row.id, action_type=row.action_type, status=row.status, candidate_id=row.candidate_id, job_id=row.job_id, payload=loads(row.payload_json, {}), result=loads(row.result_json, {}), created_by=row.created_by, confirmed_by=row.confirmed_by, created_at=row.created_at, updated_at=row.updated_at)

    def create(self, payload: ActionCreate, actor: str = "local") -> ActionResponse:
        if self.db.get(CandidateRecord, payload.candidate_id) is None:
            raise LookupError("未找到候选人")
        if payload.job_id and self.db.get(JobRecord, payload.job_id) is None:
            raise LookupError("未找到岗位")
        key = payload.idempotency_key or hashlib.sha256(dumps(payload.model_dump()).encode("utf-8")).hexdigest()
        existing = self.db.scalar(select(ActionRecord).where(ActionRecord.idempotency_key == key))
        if existing is not None:
            return self._response(existing)
        if payload.action_type == "send_message" and not str(payload.payload.get("text", "")).strip():
            raise ValueError("发送消息动作必须提供 text")
        if payload.action_type == "candidate_stage" and payload.payload.get("stage") not in STAGES:
            raise ValueError("不允许的候选人阶段")
        if payload.action_type == "boss_action" and payload.payload.get("action") not in ALLOWED_BOSS_ACTIONS:
            raise ValueError("不允许的 BOSS action")
        row = ActionRecord(action_type=payload.action_type, candidate_id=payload.candidate_id, job_id=payload.job_id, payload_json=dumps(payload.payload), status="pending_confirmation", idempotency_key=key, created_by=actor[:128] or "local")
        self.db.add(row)
        self.db.flush()
        self._audit("action_created", row.id, {"action_type": row.action_type, "payload": payload.payload}, actor)
        self.db.commit()
        self.db.refresh(row)
        return self._response(row)

    async def confirm(self, action_id: str, actor: str = "local") -> ActionResponse:
        row = self.db.get(ActionRecord, action_id)
        if row is None:
            raise LookupError("未找到动作")
        if row.status in {"success", "cancelled", "blocked", "failed"}:
            return self._response(row)
        if row.status != "pending_confirmation":
            raise ValueError(f"动作当前状态不可确认：{row.status}")
        row.confirmed_by = actor[:128] or "local"
        row.status = "confirmed"
        self._audit("action_confirmed", row.id, {}, actor)
        self.db.commit()
        payload = loads(row.payload_json, {})
        if self.settings.automation_emergency_stop:
            row.status = "blocked"
            row.result_json = dumps({"reason": "紧急停止开关已开启"})
            self._audit("action_blocked", row.id, {"reason": "emergency_stop"}, actor)
            self.db.commit()
            return self._response(row)
        if row.action_type == "candidate_stage":
            candidate = self.db.get(CandidateRecord, row.candidate_id)
            stage = str(payload.get("stage", "")).strip()
            if candidate is None or stage not in STAGES:
                row.status = "failed"
                row.result_json = dumps({"reason": "缺少候选人或不允许的 stage"})
            else:
                candidate.stage = stage
                row.status = "success"
                row.result_json = dumps({"local_only": True, "stage": stage})
            self._audit("action_finished", row.id, loads(row.result_json, {}), actor)
            self.db.commit()
            return self._response(row)
        if not self.settings.boss_enable_writes:
            row.status = "blocked"
            row.result_json = dumps({"reason": "BOSS 写操作开关未启用", "hint": "设置 BOSS_ENABLE_WRITES=true 后重启后端，并重新创建动作"})
            self._audit("action_blocked", row.id, {"reason": "writes_disabled"}, actor)
            self.db.commit()
            return self._response(row)
        if self.adapter is None:
            row.status = "failed"
            row.result_json = dumps({"reason": "未配置 BOSS 适配器"})
            self.db.commit()
            return self._response(row)
        row.status = "executing"
        self.db.commit()
        try:
            candidate = self.db.get(CandidateRecord, row.candidate_id)
            if candidate is None:
                raise LookupError("候选人不存在")
            await self.adapter.run("chat", candidate.name, "--strict")
            if row.action_type == "send_message":
                result = await self.adapter.run("send", "--text", str(payload["text"]))
            else:
                args = ["action", str(payload["action"])]
                if payload.get("remark"):
                    args.extend(["--remark", str(payload["remark"])])
                result = await self.adapter.run(*args)
            row.status = "success"
            row.result_json = dumps({"stdout": result.stdout[-2000:], "returncode": result.returncode})
        except Exception as exc:
            row.status = "failed"
            row.result_json = dumps({"reason": str(exc)[:2000]})
        self._audit("action_finished", row.id, loads(row.result_json, {}), actor)
        self.db.commit()
        return self._response(row)

    def cancel(self, action_id: str, actor: str = "local") -> ActionResponse:
        row = self.db.get(ActionRecord, action_id)
        if row is None:
            raise LookupError("未找到动作")
        if row.status not in {"pending_confirmation", "confirmed"}:
            raise ValueError(f"动作当前状态不可取消：{row.status}")
        row.status = "cancelled"
        row.result_json = dumps({"reason": "人工取消"})
        self._audit("action_cancelled", row.id, {}, actor)
        self.db.commit()
        return self._response(row)

    def list(self, limit: int = 100) -> list[ActionResponse]:
        rows = self.db.scalars(select(ActionRecord).order_by(ActionRecord.created_at.desc()).limit(min(limit, 500))).all()
        return [self._response(row) for row in rows]

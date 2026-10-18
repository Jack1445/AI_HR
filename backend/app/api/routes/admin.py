from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import AuditEventRecord, CandidateRecord, JobRecord
from app.db.session import get_db

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/audit", response_model=list[dict[str, object]])
def audit(limit: int = Query(default=100, ge=1, le=500), db: Session = Depends(get_db)) -> list[dict[str, object]]:
    rows = db.scalars(select(AuditEventRecord).order_by(AuditEventRecord.created_at.desc()).limit(limit)).all()
    return [{"id": row.id, "actor": row.actor, "event_type": row.event_type, "target_type": row.target_type, "target_id": row.target_id, "detail": row.detail_json, "created_at": row.created_at} for row in rows]


@router.get("/metrics", response_model=dict[str, int])
def metrics(db: Session = Depends(get_db)) -> dict[str, int]:
    return {"jobs": int(db.scalar(select(func.count(JobRecord.id))) or 0), "candidates": int(db.scalar(select(func.count(CandidateRecord.id))) or 0), "audit_events": int(db.scalar(select(func.count(AuditEventRecord.id))) or 0)}

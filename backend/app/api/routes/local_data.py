from fastapi import APIRouter, Depends, Header, HTTPException, Query
from datetime import date, datetime, timedelta, timezone
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.adapters.boss_cli import BossCliCommandNotFoundError, BossCliExecutionError, BossCliTimeoutError
from app.db.models import CandidateRecord, JobCandidateRecord, MessageTemplateRecord, TimelineEventRecord
from app.db.session import get_db
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.local import CandidateDetail, CandidateUpdate, FunnelResponse, LocalCandidateListResponse, LocalJobListResponse, NoteCreate, SyncResponse, TagUpdate, TemplateCreate, TimelineEvent
from app.services.boss_readonly import BossReadOnlyService, get_boss_cli_adapter
from app.services.local_store import LocalStoreService
from app.services.operation_lock import manual_read_lock

router = APIRouter(prefix="/api/local", tags=["local-data"])


def service(db: Session = Depends(get_db)) -> LocalStoreService:
    return LocalStoreService(db, BossReadOnlyService(get_boss_cli_adapter()))


def map_sync_error(error: Exception) -> HTTPException:
    if isinstance(error, IntegrityError):
        return HTTPException(status_code=500, detail="本地数据库保存失败：数据关联发生冲突，请查看诊断日志")
    if isinstance(error, SQLAlchemyError):
        return HTTPException(status_code=500, detail="本地数据库读写失败，请查看诊断日志")
    if isinstance(error, BossCliTimeoutError):
        return HTTPException(status_code=504, detail=str(error))
    if isinstance(error, (BossCliCommandNotFoundError, BossCliExecutionError, BossCliOutputError)):
        return HTTPException(status_code=502, detail=str(error))
    detail = str(error).strip() or repr(error)
    return HTTPException(status_code=500, detail=f"同步招聘数据时发生未分类错误：{detail[:1000]}")


@router.post("/sync", response_model=SyncResponse)
async def sync(
    scope: str = Query(default="all", pattern="^(all|jobs)$"),
    diagnostic: bool = Query(default=False),
    since: date | None = Query(default=None, description="北京时间起始日期（含当天）至今；留空为全部历史"),
    svc: LocalStoreService = Depends(service),
) -> SyncResponse:
    try:
        if since and since > datetime.now(timezone(timedelta(hours=8))).date():
            raise HTTPException(422, "起始日期不能晚于今天")
        if manual_read_lock.locked():
            raise HTTPException(409, '已有读取或删除任务，请等待完成')
        async with manual_read_lock:
            return await svc.sync(scope, diagnostic=diagnostic, since=since)
    except HTTPException:
        raise
    except Exception as error:
        mapped = map_sync_error(error)
        if svc.diagnostic_log_path:
            mapped.detail = f"{mapped.detail}；诊断日志：{svc.diagnostic_log_path}"
        raise mapped from error


@router.get("/jobs", response_model=LocalJobListResponse)
def local_jobs(svc: LocalStoreService = Depends(service)) -> LocalJobListResponse:
    return svc.list_jobs()


@router.get("/candidates", response_model=LocalCandidateListResponse)
def local_candidates(
    job_id: str | None = None,
    stage: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    favorite: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    svc: LocalStoreService = Depends(service),
) -> LocalCandidateListResponse:
    return svc.list_candidates(job_id, stage, tag, q, favorite, limit, offset)


@router.get("/candidates/{candidate_id}", response_model=CandidateDetail)
def local_candidate(candidate_id: str, svc: LocalStoreService = Depends(service)) -> CandidateDetail:
    try:
        return svc.detail(candidate_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.patch("/candidates/{candidate_id}", response_model=CandidateDetail)
def update_candidate(candidate_id: str, payload: CandidateUpdate, x_actor: str | None = Header(default=None), svc: LocalStoreService = Depends(service)) -> CandidateDetail:
    try:
        return svc.update_candidate(candidate_id, payload, x_actor or "local")
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/candidates/{candidate_id}/notes", response_model=CandidateDetail)
def add_note(candidate_id: str, payload: NoteCreate, svc: LocalStoreService = Depends(service)) -> CandidateDetail:
    try:
        return svc.add_note(candidate_id, payload)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.put("/candidates/{candidate_id}/tags", response_model=CandidateDetail)
def update_tags(candidate_id: str, payload: TagUpdate, svc: LocalStoreService = Depends(service)) -> CandidateDetail:
    try:
        return svc.update_tags(candidate_id, payload)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/candidates/{candidate_id}/timeline", response_model=list[TimelineEvent])
def candidate_timeline(candidate_id: str, db: Session = Depends(get_db)) -> list[TimelineEvent]:
    if db.get(CandidateRecord, candidate_id) is None:
        raise HTTPException(status_code=404, detail="未找到候选人")
    rows = db.scalars(select(TimelineEventRecord).where(TimelineEventRecord.candidate_id == candidate_id).order_by(TimelineEventRecord.event_at.desc())).all()
    return [TimelineEvent(id=row.id, event_type=row.event_type, title=row.title, content=row.content, event_at=row.event_at, actor=row.actor) for row in rows]


@router.get("/funnel", response_model=FunnelResponse)
def funnel(job_id: str | None = None, db: Session = Depends(get_db)) -> FunnelResponse:
    stmt = select(CandidateRecord.stage, func.count(CandidateRecord.id))
    if job_id:
        stmt = stmt.join(JobCandidateRecord, JobCandidateRecord.candidate_id == CandidateRecord.id).where(JobCandidateRecord.job_id == job_id)
    rows = db.execute(stmt.group_by(CandidateRecord.stage)).all()
    counts = {stage: int(count) for stage, count in rows}
    return FunnelResponse(job_id=job_id, counts=counts, total=sum(counts.values()))


@router.get("/reminders", response_model=LocalCandidateListResponse)
def reminders(svc: LocalStoreService = Depends(service)) -> LocalCandidateListResponse:
    return svc.list_reminders(limit=500)


@router.post("/templates", response_model=dict[str, str])
def create_template(payload: TemplateCreate, db: Session = Depends(get_db)) -> dict[str, str]:
    existing = db.scalar(select(MessageTemplateRecord).where(MessageTemplateRecord.name == payload.name))
    if existing is not None:
        raise HTTPException(status_code=409, detail="模板名称已存在")
    row = MessageTemplateRecord(name=payload.name, content=payload.content)
    db.add(row)
    db.commit()
    return {"id": row.id, "name": row.name, "content": row.content}


@router.get("/templates", response_model=list[dict[str, str]])
def list_templates(db: Session = Depends(get_db)) -> list[dict[str, str]]:
    rows = db.scalars(select(MessageTemplateRecord).order_by(MessageTemplateRecord.updated_at.desc())).all()
    return [{"id": row.id, "name": row.name, "content": row.content} for row in rows]

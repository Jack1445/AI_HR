from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import RecommendationGreetingBatchRecord as Batch
from app.db.session import get_db, SessionLocal
from app.services.operation_lock import manual_read_lock
from app.services.recommendation_greetings import (ACTIVE, GreetingRequest, create_batch,
                                                  execute_batch, existing_request, view, recover_interrupted_greetings)


def local_origin(request: Request):
    allowed = {*get_settings().cors_origin_list, 'http://localhost:5173', 'http://127.0.0.1:5173'}
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin not in allowed and origin != str(request.base_url).rstrip('/')):
        raise HTTPException(403, '请从本地工作台确认打招呼')


router = APIRouter(prefix='/api/recommendation-greetings', tags=['manual-greetings'], dependencies=[Depends(local_origin)])


@router.get('')
def batches(db: Session = Depends(get_db)):
    # Active tasks sort first, allowing refresh/tab changes to recover the lock and progress.
    return [view(row) for row in db.scalars(select(Batch).order_by(Batch.status.in_(ACTIVE).desc(), Batch.created_at.desc()).limit(20))]


async def run_reserved(batch_id):
    try:
        await execute_batch(batch_id)
    except BaseException:
        # Even cancellation must not leave the task appearing active until a restart.
        with SessionLocal() as db:
            recover_interrupted_greetings(db)
        raise
    finally:
        manual_read_lock.release()


@router.post('', status_code=202)
async def start(payload: GreetingRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
    try:
        existing = existing_request(db, payload)
        if existing:
            return view(existing)
        if manual_read_lock.locked():
            raise HTTPException(409, 'BOSS 正在执行其他任务，请等待完成后再打招呼')
        await manual_read_lock.acquire()
        try:
            batch = create_batch(db, payload)
        except BaseException:
            manual_read_lock.release()
            raise
        background.add_task(run_reserved, batch.id)
        return view(batch)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

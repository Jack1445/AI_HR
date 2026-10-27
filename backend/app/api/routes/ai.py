import asyncio
from threading import Lock
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import AIManagedRunRecord
from app.db.session import get_db
from app.schemas.ai import AIConfigSave, AISelection
from app.services.ai_management import AIManagementService, call_model, execute_run, fetch_models


def local_origin(request: Request):
    origin = request.headers.get('origin')
    allowed = {*get_settings().cors_origin_list, 'http://localhost:5173', 'http://127.0.0.1:5173'}
    if origin and origin not in allowed and origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '请从本地工作台操作 AI 配置')


router = APIRouter(prefix='/api/ai', tags=['ai-management'], dependencies=[Depends(local_origin)])
run_lock = Lock()


@router.get('/config')
def config(db: Session = Depends(get_db)):
    return AIManagementService(db).public_config()


@router.put('/config')
def save_config(payload: AIConfigSave, db: Session = Depends(get_db)):
    try:
        return AIManagementService(db).save_config(payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/test')
async def test_connection(db: Session = Depends(get_db)):
    try:
        config, key = AIManagementService(db).ready_config()
        db.commit()
        async with asyncio.timeout(config.timeout_seconds + 5):
            result = await call_model(config, key, '这是连接测试。请只回复 OK。')
        return {'ok': True, 'elapsed_seconds': result['elapsed_seconds'], 'usage': result['usage']}
    except (ValueError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or '模型请求超时') from exc


@router.post('/models')
async def models(db: Session = Depends(get_db)):
    try:
        config, key = AIManagementService(db).connection_config()
        db.commit()
        async with asyncio.timeout(35):
            return await fetch_models(config, key)
    except (ValueError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or '获取模型列表超时') from exc


@router.get('/data')
def data(source: Literal['recommendations', 'communications'], job_id: str = '', db: Session = Depends(get_db)):
    return AIManagementService(db).catalog(source, job_id)


@router.post('/preview')
def preview(payload: AISelection, db: Session = Depends(get_db)):
    try:
        return {'items': AIManagementService(db).snapshot(payload)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/runs', status_code=202)
def start_run(payload: AISelection, background: BackgroundTasks, db: Session = Depends(get_db)):
    try:
        with run_lock:
            row, config, key = AIManagementService(db).create_run(payload)
        background.add_task(execute_run, row.id, config, key)
        return AIManagementService.run_view(row)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/runs')
def runs(db: Session = Depends(get_db)):
    return [AIManagementService.run_view(row, detail=False) for row in db.scalars(select(AIManagedRunRecord).order_by(AIManagedRunRecord.created_at.desc()).limit(30))]


@router.get('/runs/{run_id}')
def run(run_id: str, db: Session = Depends(get_db)):
    row = db.get(AIManagedRunRecord, run_id)
    if row is None:
        raise HTTPException(404, '分析任务不存在')
    return AIManagementService.run_view(row)

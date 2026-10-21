import asyncio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.discovery import ClassifyRequest, RecommendationLibrary, RecommendationReadResult, CaptureRecommendedResumeRequest, OnlineResumeScreenshot, RecommendationRecycleBin
from app.schemas.local import LocalCandidateListResponse
from app.services.boss_readonly import get_boss_cli_adapter
from app.services.discovery import DiscoveryService
from app.api.routes.local_data import map_sync_error
from app.parsers.boss_cli_output import BossCliOutputError

router = APIRouter(prefix='/api/local', tags=['manual-discovery'])
manual_read_lock = asyncio.Lock()


def service(db: Session = Depends(get_db)) -> DiscoveryService:
    return DiscoveryService(db, get_boss_cli_adapter())


@router.get('/recommendations', response_model=RecommendationLibrary)
def recommendations(svc: DiscoveryService = Depends(service)) -> RecommendationLibrary:
    # Cache only. Loading this page must NEVER open BOSS.
    return svc.recommendations()


@router.get('/recommendations/recycle-bin', response_model=RecommendationRecycleBin)
def recycle_bin(svc: DiscoveryService = Depends(service)) -> RecommendationRecycleBin:
    return svc.recycle_bin()


@router.post('/recommendations/recycle-bin/{identity_key}/restore', status_code=204)
async def allow_recommendation_again(identity_key: str, svc: DiscoveryService = Depends(service)) -> None:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请完成后再操作回收站')
    async with manual_read_lock:
        try:
            svc.allow_recommendation_again(identity_key)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error


@router.post('/recommendations/read', response_model=RecommendationReadResult)
async def read_recommendations(svc: DiscoveryService = Depends(service)) -> RecommendationReadResult:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请等待完成后再点击')
    async with manual_read_lock:
        try:
            return await svc.read_recommendations()
        except Exception as error:
            raise map_sync_error(error) from error


@router.post('/communications/verify', response_model=LocalCandidateListResponse)
async def classify(payload: ClassifyRequest, svc: DiscoveryService = Depends(service)) -> LocalCandidateListResponse:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请等待完成后再点击')
    async with manual_read_lock:
        try:
            return await svc.classify(payload.candidate_ids)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except BossCliOutputError as error:
            raise map_sync_error(error) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise map_sync_error(error) from error


@router.post('/recommendations/resume', response_model=OnlineResumeScreenshot)
async def capture_resume(payload: CaptureRecommendedResumeRequest, svc: DiscoveryService = Depends(service)) -> OnlineResumeScreenshot:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请等待完成后再点击')
    async with manual_read_lock:
        try:
            return await svc.capture_resume(payload.geek_id, payload.candidate_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except Exception as error:
            raise map_sync_error(error) from error


@router.get('/recommendation-resumes/{screenshot_id}/image')
def resume_image(screenshot_id: str, svc: DiscoveryService = Depends(service)) -> FileResponse:
    try:
        path = svc.resume_image(screenshot_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


@router.delete('/recommendations/{candidate_id}', status_code=204)
async def delete_recommendation(candidate_id: str, svc: DiscoveryService = Depends(service)) -> None:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请完成后再删除')
    async with manual_read_lock:
        try:
            svc.delete_recommendation(candidate_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

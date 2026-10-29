from app.services.operation_lock import manual_read_lock
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.discovery import AttachmentDownloadReceipt, AttachmentDownloadRequest, ClassifyRequest, RecommendationLibrary, RecommendationReadResult, CaptureRecommendedResumeRequest, OnlineResumeScreenshot, RecommendationRecycleBin
from app.schemas.local import LocalCandidateListResponse
from app.services.boss_readonly import get_boss_cli_adapter
from app.services.discovery import DiscoveryService
from app.api.routes.local_data import map_sync_error
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.discovery import RecommendationReadRequest

router = APIRouter(prefix='/api/local', tags=['manual-discovery'])


def service(db: Session = Depends(get_db)) -> DiscoveryService:
    return DiscoveryService(db, get_boss_cli_adapter())


@router.get('/recommendations', response_model=RecommendationLibrary)
def recommendations(job_key: str | None = None, svc: DiscoveryService = Depends(service)) -> RecommendationLibrary:
    # Cache only. Loading this page must NEVER open BOSS.
    try:
        return svc.recommendations(job_key)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error


@router.get('/recommendations/jobs')
def recommendation_jobs(svc: DiscoveryService = Depends(service)):
    return svc.jobs()


@router.post('/recommendations/jobs/read')
async def read_recommendation_jobs(svc: DiscoveryService = Depends(service)):
    if manual_read_lock.locked():
        raise HTTPException(409, '已有读取任务，请等待完成')
    async with manual_read_lock:
        try:
            return await svc.read_jobs()
        except Exception as error:
            raise map_sync_error(error) from error


@router.get('/recommendations/recycle-bin', response_model=RecommendationRecycleBin)
def recycle_bin(job_key: str | None = None, svc: DiscoveryService = Depends(service)) -> RecommendationRecycleBin:
    return svc.recycle_bin(job_key)


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
async def read_recommendations(payload: RecommendationReadRequest, svc: DiscoveryService = Depends(service)) -> RecommendationReadResult:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请等待完成后再点击')
    async with manual_read_lock:
        try:
            return await svc.read_recommendations(payload.job_key)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except Exception as error:
            raise map_sync_error(error) from error


@router.post('/communications/verify', response_model=LocalCandidateListResponse)
async def classify(payload: ClassifyRequest, svc: DiscoveryService = Depends(service)) -> LocalCandidateListResponse:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有手动读取任务，请等待完成后再点击')
    async with manual_read_lock:
        try:
            return await svc.classify(payload.candidate_ids, accept_incoming_resumes=payload.accept_incoming_resumes)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except BossCliOutputError as error:
            raise map_sync_error(error) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise map_sync_error(error) from error


@router.post('/communications/attachment', response_model=AttachmentDownloadReceipt)
async def download_communication_attachment(payload: AttachmentDownloadRequest, svc: DiscoveryService = Depends(service)) -> AttachmentDownloadReceipt:
    if manual_read_lock.locked():
        raise HTTPException(status_code=409, detail='已有 BOSS 读取任务，请等待完成')
    async with manual_read_lock:
        try:
            resume, already_saved, saved_folder = await svc.download_attachment(payload.candidate_id, payload.job_id)
            return AttachmentDownloadReceipt(id=resume.id, candidate_id=resume.candidate_id, original_name=resume.original_name, size_bytes=resume.size_bytes, already_saved=already_saved, saved_folder=saved_folder)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
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

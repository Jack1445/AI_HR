from fastapi import APIRouter, Depends, HTTPException

from app.adapters.boss_cli import (
    BossCliCommandNotFoundError,
    BossCliExecutionError,
    BossCliTimeoutError,
)
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.recruiting import CandidateListResponse, JobListResponse
from app.services.boss_readonly import BossReadOnlyService, get_boss_cli_adapter

router = APIRouter(prefix="/api", tags=["recruiting"])


def get_read_only_service() -> BossReadOnlyService:
    return BossReadOnlyService(get_boss_cli_adapter())


def map_boss_error(error: Exception) -> HTTPException:
    if isinstance(error, LookupError):
        return HTTPException(status_code=404, detail=str(error))
    if isinstance(error, BossCliCommandNotFoundError):
        return HTTPException(status_code=503, detail=str(error))
    if isinstance(error, BossCliTimeoutError):
        return HTTPException(status_code=504, detail=str(error))
    if isinstance(error, (BossCliExecutionError, BossCliOutputError)):
        return HTTPException(status_code=502, detail=str(error))
    return HTTPException(status_code=500, detail="读取招聘数据时发生未分类错误")


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(service: BossReadOnlyService = Depends(get_read_only_service)) -> JobListResponse:
    try:
        return await service.list_jobs()
    except Exception as error:
        raise map_boss_error(error) from error


@router.get("/jobs/{job_id}/candidates", response_model=CandidateListResponse)
async def list_job_candidates(
    job_id: str,
    service: BossReadOnlyService = Depends(get_read_only_service),
) -> CandidateListResponse:
    try:
        return await service.list_candidates_for_job(job_id)
    except Exception as error:
        raise map_boss_error(error) from error

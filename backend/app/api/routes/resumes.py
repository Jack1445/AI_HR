from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.schemas.local import ResumeResponse
from app.services.resumes import ResumeService

router = APIRouter(prefix="/api", tags=["resumes"])


def service(db: Session = Depends(get_db)) -> ResumeService:
    return ResumeService(db, get_settings())


@router.post("/candidates/{candidate_id}/resumes", response_model=ResumeResponse)
async def import_resume(candidate_id: str, request: Request, svc: ResumeService = Depends(service)) -> ResumeResponse:
    try:
        filename = request.headers.get("x-filename", "resume.txt")
        content_type = request.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
        return svc.import_file(candidate_id, filename, content_type, await request.body())
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/candidates/{candidate_id}/resumes", response_model=list[ResumeResponse])
def list_resumes(candidate_id: str, svc: ResumeService = Depends(service)) -> list[ResumeResponse]:
    try:
        return svc.list(candidate_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/resumes/search", response_model=list[ResumeResponse])
def search_resumes(q: str = Query(min_length=1, max_length=200), candidate_id: str | None = None, svc: ResumeService = Depends(service)) -> list[ResumeResponse]:
    return svc.search(q, candidate_id)


@router.get("/resumes/{resume_id}", response_model=ResumeResponse)
def get_resume(resume_id: str, svc: ResumeService = Depends(service)) -> ResumeResponse:
    try:
        return svc.get(resume_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/resumes/{resume_id}/reparse", response_model=ResumeResponse)
def reparse_resume(resume_id: str, svc: ResumeService = Depends(service)) -> ResumeResponse:
    try:
        return svc.reparse(resume_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/resumes/{resume_id}/download")
def download_resume(resume_id: str, svc: ResumeService = Depends(service)) -> FileResponse:
    try:
        path = svc.path(resume_id)
        row = svc.get(resume_id)
        return FileResponse(path, media_type=row.content_type, filename=row.original_name)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.delete("/resumes/{resume_id}", status_code=204)
def delete_resume(resume_id: str, svc: ResumeService = Depends(service)) -> None:
    try:
        svc.delete(resume_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

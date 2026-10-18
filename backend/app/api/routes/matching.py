from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.local import MatchRequest, MatchResult
from app.services.matching import MatchingService

router = APIRouter(prefix="/api", tags=["matching"])


@router.post("/candidates/{candidate_id}/match", response_model=MatchResult)
def match_candidate(candidate_id: str, payload: MatchRequest, db: Session = Depends(get_db)) -> MatchResult:
    try:
        return MatchingService(db).analyze(candidate_id, payload.job_id, payload.force)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["system"])


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    timestamp: datetime


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Return a process-local health result without contacting BOSS."""

    return HealthResponse(
        status="ok",
        service="ai-hr-backend",
        version="0.2.0",
        timestamp=datetime.now(timezone.utc),
    )

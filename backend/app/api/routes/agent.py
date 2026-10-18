from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.schemas.local import AgentTaskCreate, AgentTaskResponse
from app.services.agent import AgentTaskService
from app.services.boss_readonly import BossReadOnlyService, get_boss_cli_adapter
from app.services.local_store import LocalStoreService

router = APIRouter(prefix="/api/agent", tags=["agent"])


def service(db: Session = Depends(get_db)) -> AgentTaskService:
    return AgentTaskService(db, get_settings(), LocalStoreService(db, BossReadOnlyService(get_boss_cli_adapter())))


@router.get("/policy", response_model=dict[str, object])
def policy() -> dict[str, object]:
    settings = get_settings()
    return {"read_scopes": ["jobs", "candidates", "timeline", "resumes"], "write_scopes": ["send_message", "boss_action"], "writes_enabled": settings.boss_enable_writes, "emergency_stop": settings.automation_emergency_stop, "confirmation_required": True, "batch_limit": 50}


@router.post("/tasks", response_model=AgentTaskResponse)
async def create_task(payload: AgentTaskCreate, x_actor: str | None = Header(default=None), svc: AgentTaskService = Depends(service)) -> AgentTaskResponse:
    return await svc.create_and_run(payload, x_actor or "local")


@router.get("/tasks", response_model=list[AgentTaskResponse])
def list_tasks(limit: int = Query(default=100, ge=1, le=500), svc: AgentTaskService = Depends(service)) -> list[AgentTaskResponse]:
    return svc.list(limit)


@router.get("/tasks/{task_id}", response_model=AgentTaskResponse)
def get_task(task_id: str, svc: AgentTaskService = Depends(service)) -> AgentTaskResponse:
    try:
        return svc.get(task_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/tasks/{task_id}/cancel", response_model=AgentTaskResponse)
def cancel_task(task_id: str, svc: AgentTaskService = Depends(service)) -> AgentTaskResponse:
    try:
        return svc.cancel(task_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/tasks/{task_id}/retry", response_model=AgentTaskResponse)
async def retry_task(task_id: str, x_actor: str | None = Header(default=None), svc: AgentTaskService = Depends(service)) -> AgentTaskResponse:
    try:
        return await svc.retry(task_id, x_actor or "local")
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

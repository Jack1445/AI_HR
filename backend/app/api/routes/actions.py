from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.boss_cli import BossCliAdapter
from app.core.config import get_settings
from app.db.session import get_db
from app.schemas.local import ActionCreate, ActionResponse
from app.services.actions import ActionService
from app.services.boss_readonly import get_boss_cli_adapter

router = APIRouter(prefix="/api/actions", tags=["controlled-actions"])


def service(db: Session = Depends(get_db)) -> ActionService:
    return ActionService(db, get_settings(), get_boss_cli_adapter())


@router.post("", response_model=ActionResponse)
def create_action(payload: ActionCreate, x_actor: str | None = Header(default=None), svc: ActionService = Depends(service)) -> ActionResponse:
    try:
        return svc.create(payload, x_actor or "local")
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("", response_model=list[ActionResponse])
def list_actions(limit: int = Query(default=100, ge=1, le=500), svc: ActionService = Depends(service)) -> list[ActionResponse]:
    return svc.list(limit)


@router.post("/{action_id}/confirm", response_model=ActionResponse)
async def confirm_action(action_id: str, x_actor: str | None = Header(default=None), svc: ActionService = Depends(service)) -> ActionResponse:
    try:
        return await svc.confirm(action_id, x_actor or "local")
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/{action_id}/cancel", response_model=ActionResponse)
def cancel_action(action_id: str, x_actor: str | None = Header(default=None), svc: ActionService = Depends(service)) -> ActionResponse:
    try:
        return svc.cancel(action_id, x_actor or "local")
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/emergency-stop", response_model=dict[str, bool])
def emergency_stop(enabled: bool = True) -> dict[str, bool]:
    settings = get_settings()
    settings.automation_emergency_stop = enabled
    return {"automation_emergency_stop": settings.automation_emergency_stop}

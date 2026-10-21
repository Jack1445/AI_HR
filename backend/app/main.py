from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.health import router as health_router
from app.api.routes.recruiting import router as recruiting_router
from app.api.routes.local_data import router as local_data_router
from app.api.routes.matching import router as matching_router
from app.api.routes.actions import router as actions_router
from app.api.routes.resumes import router as resumes_router
from app.api.routes.agent import router as agent_router
from app.api.routes.admin import router as admin_router
from app.api.routes.debug import router as debug_router
from app.api.routes.discovery import router as discovery_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.base import Base
from app.db.session import engine

settings = get_settings()
configure_logging(settings.log_level)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="AI Recruiter API",
    version="0.2.9",
    description="只读优先的招聘管理后端。",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(recruiting_router)
app.include_router(local_data_router)
app.include_router(matching_router)
app.include_router(actions_router)
app.include_router(resumes_router)
app.include_router(agent_router)
app.include_router(admin_router)
app.include_router(debug_router)
app.include_router(discovery_router)

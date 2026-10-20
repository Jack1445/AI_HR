from __future__ import annotations

import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import SyncRunRecord
from app.db.session import get_db


router = APIRouter(prefix="/api/debug", tags=["debug"])


def _project_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _resolve_project_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else _project_root() / path


def _latest_diagnostic_log(data_dir: str) -> Path | None:
    root = _resolve_project_path(data_dir) / "diagnostics"
    if not root.is_dir():
        return None
    logs = sorted(root.glob("sync-*.log"), key=lambda item: item.stat().st_mtime, reverse=True)
    return logs[0] if logs else None


def _summarize_log(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"latest_log": None, "events": []}
    events: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-100:]
    except OSError as exc:
        return {"latest_log": str(path), "read_error": str(exc), "events": []}

    safe_detail_keys = {
        "scope",
        "cwd",
        "debug",
        "returncode",
        "elapsed_seconds",
        "timeout_seconds",
        "count",
        "remote_total",
        "job_id",
        "job_count",
        "candidate_count",
        "sync_id",
        "records_seen",
        "records_written",
        "error",
    }
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        item: dict[str, Any] = {
            "time": record.get("time"),
            "pid": record.get("pid"),
            "event": record.get("event"),
        }
        details = record.get("details")
        if isinstance(details, dict):
            safe_details = {key: value for key, value in details.items() if key in safe_detail_keys}
            invocation = details.get("invocation")
            if isinstance(invocation, list):
                safe_details["invocation"] = invocation
            for output_key in ("stdout", "stderr"):
                output = details.get(output_key)
                if isinstance(output, str):
                    safe_details[f"{output_key}_chars"] = len(output)
            item["details"] = safe_details
        events.append(item)
    return {"latest_log": str(path), "events": events}


@router.get("/status", response_model=dict[str, Any])
def status(db: Session = Depends(get_db)) -> dict[str, Any]:
    settings = get_settings()
    latest_sync = db.scalar(select(SyncRunRecord).order_by(SyncRunRecord.started_at.desc()).limit(1))
    entrypoint = _resolve_project_path(settings.boss_cli_entrypoint)
    data_dir = _resolve_project_path(settings.data_dir)
    sync_payload: dict[str, Any] | None = None
    if latest_sync is not None:
        sync_payload = {
            "id": latest_sync.id,
            "scope": latest_sync.scope,
            "status": latest_sync.status,
            "started_at": latest_sync.started_at,
            "finished_at": latest_sync.finished_at,
            "records_seen": latest_sync.records_seen,
            "records_written": latest_sync.records_written,
            "error_summary": latest_sync.error_summary,
        }
    return {
        "server_time": datetime.now(timezone.utc),
        "runtime": {
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "cwd": str(Path.cwd()),
        },
        "config": {
            "boss_cli_command": settings.boss_cli_command,
            "boss_cli_entrypoint": settings.boss_cli_entrypoint,
            "boss_cli_entrypoint_resolved": str(entrypoint),
            "boss_cli_entrypoint_exists": entrypoint.is_file(),
            "boss_cli_timeout_seconds": settings.boss_cli_timeout_seconds,
            "boss_enable_writes": settings.boss_enable_writes,
            "automation_emergency_stop": settings.automation_emergency_stop,
            "data_dir": str(data_dir),
            "data_dir_exists": data_dir.is_dir(),
            "database_kind": "sqlite" if settings.database_url.startswith("sqlite") else "configured",
        },
        "latest_sync": sync_payload,
        "diagnostics": _summarize_log(_latest_diagnostic_log(settings.data_dir)),
    }

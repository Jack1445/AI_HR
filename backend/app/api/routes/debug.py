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
from app.db.errors import redact_legacy_sql_error
from app.db.session import get_db
from app.services.boss_readonly import get_boss_cli_adapter


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
        return {"latest_log": None, "events": [], "timings": []}
    events: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-500:]
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
        "command_id", "command", "child_pid", "stage", "status", "span_id",
        "time", "pid", "bytes", "stdout_chars", "stderr_chars",
        "after_cleanup_seconds",
        "blocking_command_id", "blocking_command", "blocking_elapsed_seconds", "blocking_log",
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
            "elapsed_seconds": record.get("elapsed_seconds"),
        }
        details = record.get("details")
        if isinstance(details, dict):
            safe_details = {key: value for key, value in details.items() if key in safe_detail_keys}
            if isinstance(safe_details.get('error'), str):
                safe_details['error'] = redact_legacy_sql_error(safe_details['error'])
            invocation = details.get("invocation")
            if isinstance(invocation, list):
                safe_details["invocation"] = invocation
            for output_key in ("stdout", "stderr"):
                output = details.get(output_key)
                if isinstance(output, str):
                    safe_details[f"{output_key}_chars"] = len(output)
            item["details"] = safe_details
        events.append(item)
    spans: dict[str, dict[str, Any]] = {}
    summary_events = {
        "cli.queue_acquired": "backend.queue_wait",
        "cli.spawned": "backend.spawn",
        "cli.stdout_first_byte": "backend.first_output",
        "cli.complete": "backend.command_total",
        "cli.timeout": "backend.command_timeout",
        "jobs.parsed": "backend.parse_jobs",
        "candidates.partitioned": "backend.parse_candidates",
        "sync.jobs_loaded": "sync.jobs_total",
        "sync.candidates_complete": "sync.candidates_total",
        "sync.database_complete": "sync.database",
    }
    timings = []
    start_events = {
        "cli.queue_start": "backend.queue_wait", "cli.start": "backend.command_total",
        "sync.jobs_start": "sync.jobs_total", "sync.candidates_start": "sync.candidates_total",
        "sync.database_start": "sync.database",
    }
    for event in events:
        detail = event.get("details", {})
        if event["event"] in start_events:
            stage = start_events[event["event"]]
            key = f"backend:{detail.get('command_id', '')}:{stage}"
            start = datetime.fromisoformat(event["time"])
            spans[key] = {"stage": stage, "status": "running", "command": detail.get("command", ""), "recorded_at": event["time"], "elapsed_seconds": max(0, (datetime.now(timezone.utc) - start).total_seconds())}
        if event["event"] == "cli.timing" and isinstance(detail.get("span_id"), str):
            key = detail["span_id"]
            row = {**detail, "recorded_at": event["time"]}
            if detail.get("status") == "start":
                row["status"] = "running"
                try:
                    start = datetime.fromisoformat(detail["time"])
                    row["elapsed_seconds"] = max(0, (datetime.now(timezone.utc) - start).total_seconds())
                except (KeyError, TypeError, ValueError):
                    row["elapsed_seconds"] = 0
            spans[key] = row
        elif event["event"] in summary_events:
            stage = summary_events[event["event"]]
            row = {"stage": stage, "status": "failed" if event["event"] == "cli.timeout" else "complete", "command": detail.get("command", ""), "elapsed_seconds": detail.get("elapsed_seconds", 0)}
            key = f"backend:{detail.get('command_id', '')}:{stage}"
            if key in spans:
                spans[key] = row
            else:
                timings.append(row)
            if event["event"] == "cli.complete" and detail.get("after_cleanup_seconds") is not None:
                timings.append({"stage": "backend.exit_wait", "status": "complete", "command": detail.get("command", ""), "elapsed_seconds": detail["after_cleanup_seconds"]})
    timings.extend(spans.values())
    terminal = next((e for e in reversed(events) if e["event"] in {"sync.complete", "sync.failed"}), None)
    if terminal:
        for row in timings:
            if row.get("status") == "running":
                row["status"] = "interrupted"
                start = datetime.fromisoformat(row["recorded_at"])
                end = datetime.fromisoformat(terminal["time"])
                row["elapsed_seconds"] = max(0, (end - start).total_seconds())
        timings.append({"stage": "sync.total", "status": "complete" if terminal["event"] == "sync.complete" else "failed", "command": "", "elapsed_seconds": terminal.get("elapsed_seconds", 0)})
    sync_id = next((e.get("details", {}).get("sync_id") for e in events if e["event"] == "sync.created"), None)
    return {"latest_log": str(path), "sync_id": sync_id, "events": events, "timings": timings}


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
            "error_summary": redact_legacy_sql_error(latest_sync.error_summary),
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
        "active_cli": get_boss_cli_adapter().active_command,
        "diagnostics": _summarize_log(_latest_diagnostic_log(settings.data_dir)),
    }

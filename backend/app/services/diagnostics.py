from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from app.core.config import get_settings


class DiagnosticLog:
    """Append-only, per-run diagnostic trace for one BOSS synchronization."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.started_at = time.monotonic()

    @classmethod
    def create(cls, kind: Literal["sync", "cli"] = "sync") -> "DiagnosticLog":
        data_root = Path(get_settings().data_dir)
        if not data_root.is_absolute():
            data_root = Path(__file__).resolve().parents[3] / data_root
        root = data_root / "diagnostics"
        root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        return cls(root / f"{kind}-{stamp}-{uuid.uuid4().hex[:8]}.log")

    def write(self, event: str, details: dict[str, Any] | None = None) -> None:
        record: dict[str, Any] = {
            "time": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "event": event,
            "elapsed_seconds": round(time.monotonic() - self.started_at, 4),
        }
        if details:
            record["details"] = details
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")

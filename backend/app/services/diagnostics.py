from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import get_settings


class DiagnosticLog:
    """Append-only, per-run diagnostic trace for one BOSS synchronization."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    @classmethod
    def create(cls) -> "DiagnosticLog":
        root = Path(get_settings().data_dir) / "diagnostics"
        root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        return cls(root / f"sync-{stamp}-{uuid.uuid4().hex[:8]}.log")

    def write(self, event: str, details: dict[str, Any] | None = None) -> None:
        record: dict[str, Any] = {
            "time": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "event": event,
        }
        if details:
            record["details"] = details
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")

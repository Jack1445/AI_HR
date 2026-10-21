import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from app.services.diagnostics import DiagnosticLog


class BossCliExecutionError(RuntimeError):
    """A boss-cli process failed or exceeded its configured timeout."""


class BossCliCommandNotFoundError(BossCliExecutionError):
    """The configured executable could not be launched."""


class BossCliTimeoutError(BossCliExecutionError):
    """The configured command exceeded its timeout."""


@dataclass(frozen=True)
class BossCliResult:
    args: tuple[str, ...]
    stdout: str
    stderr: str
    returncode: int


class BossCliAdapter:
    """Invoke boss-cli through a direct subprocess boundary.

    This adapter intentionally does not use a shell, retry silently, or invent a
    fallback command. Command-specific parsers and write policies live above it.
    """

    def __init__(
        self,
        command: str = "node",
        entrypoint: str = "boss-cli/dist/cli/index.js",
        timeout_seconds: float = 120.0,
    ) -> None:
        self.command = command
        self.entrypoint = entrypoint
        self.timeout_seconds = timeout_seconds
        self._lock = asyncio.Lock()
        self._active_command: dict | None = None
        self._active_started_at = 0.0

    @property
    def active_command(self) -> dict | None:
        if self._active_command is None:
            return None
        return {**self._active_command, "elapsed_seconds": time.monotonic() - self._active_started_at}

    @asynccontextmanager
    async def _command_slot(self, command_id: str, command: str, log: DiagnosticLog | None):
        async with self._lock:
            self._active_started_at = time.monotonic()
            self._active_command = {"command_id": command_id, "command": command, "diagnostic_log": str(log.path) if log else None}
            try:
                yield
            finally:
                self._active_command = None

    @property
    def invocation(self) -> tuple[str, ...]:
        if not self.entrypoint.strip():
            return (self.command,)
        entrypoint = Path(self.entrypoint)
        if not entrypoint.is_absolute():
            project_root = Path(__file__).resolve().parents[3]
            entrypoint = project_root / entrypoint
        return (self.command, str(entrypoint))

    async def run(
        self,
        *args: str,
        debug: bool = False,
        diagnostic_log: DiagnosticLog | None = None,
    ) -> BossCliResult:
        invocation = self.invocation
        # Direct read endpoints also need traces so a queued sync can identify
        # which earlier request holds the shared browser. Never log write args.
        if diagnostic_log is None and args in {("positions",), ("list",)}:
            diagnostic_log = DiagnosticLog.create(kind="cli")
        command_id = uuid.uuid4().hex[:12]
        queued_at = time.monotonic()

        def trace(event: str, details: dict | None = None) -> None:
            if diagnostic_log is not None:
                diagnostic_log.write(event, {"command_id": command_id, "command": args[0] if args else "", **(details or {})})

        blocker = self.active_command
        trace("cli.queue_start", {
            "blocking_command_id": blocker["command_id"],
            "blocking_command": blocker["command"],
            "blocking_elapsed_seconds": blocker["elapsed_seconds"],
            "blocking_log": blocker["diagnostic_log"],
        } if blocker else {})
        async with self._command_slot(command_id, args[0] if args else "", diagnostic_log):
            started_at = time.monotonic()
            trace("cli.queue_acquired", {"elapsed_seconds": started_at - queued_at})
            if diagnostic_log is not None:
                trace(
                    "cli.start",
                    {
                        "invocation": [*invocation, *args],
                        "cwd": str(Path.cwd()),
                        "debug": debug,
                    },
                )
            environment = None
            if debug or diagnostic_log is not None:
                environment = os.environ.copy()
                environment["BOSS_CLI_TIMING"] = "true"
                if debug:
                    environment["BOSS_CLI_DEBUG"] = "true"
            try:
                process = await asyncio.create_subprocess_exec(
                    *invocation,
                    *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=environment,
                )
            except FileNotFoundError as exc:
                if diagnostic_log is not None:
                    diagnostic_log.write("cli.spawn_failed", {"error": repr(exc)})
                raise BossCliCommandNotFoundError(
                    f"无法启动 boss-cli：找不到可执行文件“{self.command}”"
                ) from exc
            trace("cli.spawned", {"child_pid": process.pid, "elapsed_seconds": time.monotonic() - started_at})
            stdout_buffer = bytearray()
            stderr_buffer = bytearray()
            cleanup_finished_at: float | None = None

            async def read_stream(stream, buffer: bytearray, name: str) -> None:
                nonlocal cleanup_finished_at
                pending = b""
                first = True
                while chunk := await stream.read(8192):
                    if first:
                        trace(f"cli.{name}_first_byte", {"elapsed_seconds": time.monotonic() - started_at})
                        first = False
                    buffer.extend(chunk)
                    if name == "stderr" and diagnostic_log is not None:
                        pending += chunk
                        while b"\n" in pending:
                            line, pending = pending.split(b"\n", 1)
                            prefix = b"[boss-cli][timing] "
                            if line.startswith(prefix):
                                try:
                                    payload = json.loads(line[len(prefix):])
                                except (ValueError, UnicodeError):
                                    trace("cli.invalid_timing")
                                    continue
                                if isinstance(payload, dict):
                                    if payload.get("stage") == "cli.cleanup" and payload.get("status") == "complete":
                                        cleanup_finished_at = time.monotonic()
                                    allowed = {key: payload[key] for key in ("stage", "status", "span_id", "time", "pid", "elapsed_seconds") if key in payload}
                                    trace("cli.timing", allowed)
                        # A non-timing stderr line can be arbitrarily long.
                        if len(pending) > 65536:
                            pending = b""
                trace(f"cli.{name}_closed", {"bytes": len(buffer), "elapsed_seconds": time.monotonic() - started_at})

            async def collect() -> None:
                await asyncio.gather(
                    read_stream(process.stdout, stdout_buffer, "stdout"),
                    read_stream(process.stderr, stderr_buffer, "stderr"),
                    process.wait(),
                )

            collection = asyncio.create_task(collect())

            async def stop_process() -> None:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                try:
                    await asyncio.wait_for(asyncio.shield(collection), timeout=5)
                except asyncio.TimeoutError:
                    trace("cli.cleanup_timeout")
                    collection.cancel()
                    await asyncio.gather(collection, return_exceptions=True)

            try:
                await asyncio.wait_for(asyncio.shield(collection), timeout=self.timeout_seconds)
            except asyncio.TimeoutError as exc:
                trace("cli.timeout_detected", {"elapsed_seconds": time.monotonic() - started_at})
                await stop_process()
                if diagnostic_log is not None:
                    trace(
                        "cli.timeout",
                        {
                            "timeout_seconds": self.timeout_seconds,
                            "elapsed_seconds": time.monotonic() - started_at,
                            "stdout": stdout_buffer.decode("utf-8", errors="replace") if debug else "",
                            "stderr": stderr_buffer.decode("utf-8", errors="replace") if debug else "",
                        },
                    )
                raise BossCliTimeoutError(
                    f"boss-cli command timed out after {self.timeout_seconds:.1f}s: {' '.join((*invocation, *args))}"
                ) from exc
            except asyncio.CancelledError:
                trace("cli.cancelled")
                await stop_process()
                raise

            result = BossCliResult(
                args=tuple(args),
                stdout=stdout_buffer.decode("utf-8", errors="replace"),
                stderr=stderr_buffer.decode("utf-8", errors="replace"),
                returncode=process.returncode or 0,
            )
            if diagnostic_log is not None:
                trace(
                    "cli.complete",
                    {
                        "returncode": result.returncode,
                        "elapsed_seconds": time.monotonic() - started_at,
                        "stdout_chars": len(result.stdout),
                        "stderr_chars": len(result.stderr),
                        "after_cleanup_seconds": time.monotonic() - cleanup_finished_at if cleanup_finished_at is not None else None,
                        **({"stdout": result.stdout, "stderr": result.stderr} if debug else {}),
                    },
                )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no output"
            raise BossCliExecutionError(
                f"boss-cli command failed with exit code {result.returncode}: {detail}"
            )
        return result

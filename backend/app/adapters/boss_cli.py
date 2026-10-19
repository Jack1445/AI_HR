import asyncio
import os
import time
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
        async with self._lock:
            started_at = time.monotonic()
            if diagnostic_log is not None:
                diagnostic_log.write(
                    "cli.start",
                    {
                        "invocation": [*invocation, *args],
                        "cwd": str(Path.cwd()),
                        "debug": debug,
                    },
                )
            environment = None
            if debug:
                environment = os.environ.copy()
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
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=self.timeout_seconds
                )
            except asyncio.TimeoutError as exc:
                process.kill()
                await process.communicate()
                if diagnostic_log is not None:
                    diagnostic_log.write(
                        "cli.timeout",
                        {"timeout_seconds": self.timeout_seconds, "elapsed_seconds": time.monotonic() - started_at},
                    )
                raise BossCliTimeoutError(
                    f"boss-cli command timed out after {self.timeout_seconds:.1f}s: {' '.join((*invocation, *args))}"
                ) from exc

            result = BossCliResult(
                args=tuple(args),
                stdout=stdout_bytes.decode("utf-8", errors="replace"),
                stderr=stderr_bytes.decode("utf-8", errors="replace"),
                returncode=process.returncode or 0,
            )
            if diagnostic_log is not None:
                diagnostic_log.write(
                    "cli.complete",
                    {
                        "returncode": result.returncode,
                        "elapsed_seconds": time.monotonic() - started_at,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    },
                )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no output"
            raise BossCliExecutionError(
                f"boss-cli command failed with exit code {result.returncode}: {detail}"
            )
        return result

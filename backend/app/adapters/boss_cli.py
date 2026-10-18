import asyncio
from dataclasses import dataclass
from pathlib import Path


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

    async def run(self, *args: str) -> BossCliResult:
        invocation = self.invocation
        async with self._lock:
            try:
                process = await asyncio.create_subprocess_exec(
                    *invocation,
                    *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except FileNotFoundError as exc:
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
                raise BossCliTimeoutError(
                    f"boss-cli command timed out after {self.timeout_seconds:.1f}s: {' '.join((*invocation, *args))}"
                ) from exc

            result = BossCliResult(
                args=tuple(args),
                stdout=stdout_bytes.decode("utf-8", errors="replace"),
                stderr=stderr_bytes.decode("utf-8", errors="replace"),
                returncode=process.returncode or 0,
            )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no output"
            raise BossCliExecutionError(
                f"boss-cli command failed with exit code {result.returncode}: {detail}"
            )
        return result

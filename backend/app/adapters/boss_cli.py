import asyncio
from dataclasses import dataclass


class BossCliExecutionError(RuntimeError):
    """A boss-cli process failed or exceeded its configured timeout."""


@dataclass(frozen=True)
class BossCliResult:
    args: tuple[str, ...]
    stdout: str
    stderr: str
    returncode: int


class BossCliAdapter:
    """Invoke boss-cli through a direct subprocess boundary.

    This adapter intentionally does not use a shell, retry silently, or invent a
    fallback command. Stage 1 will add command-specific parsers on top of it.
    """

    def __init__(self, command: str = "boss", timeout_seconds: float = 120.0) -> None:
        self.command = command
        self.timeout_seconds = timeout_seconds

    async def run(self, *args: str) -> BossCliResult:
        process = await asyncio.create_subprocess_exec(
            self.command,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise BossCliExecutionError(
                f"boss-cli command timed out after {self.timeout_seconds:.1f}s: {self.command} {' '.join(args)}"
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

from functools import lru_cache

from app.adapters.boss_cli import BossCliAdapter
from app.core.config import get_settings
from app.parsers.boss_cli_output import parse_candidates, parse_positions
from app.schemas.recruiting import (
    Candidate,
    CandidateListResponse,
    Job,
    JobListResponse,
    JobStats,
)


@lru_cache(maxsize=1)
def get_boss_cli_adapter() -> BossCliAdapter:
    settings = get_settings()
    return BossCliAdapter(
        command=settings.boss_cli_command,
        entrypoint=settings.boss_cli_entrypoint,
        timeout_seconds=settings.boss_cli_timeout_seconds,
    )


class BossReadOnlyService:
    def __init__(self, adapter: BossCliAdapter) -> None:
        self.adapter = adapter

    async def list_jobs(self) -> JobListResponse:
        result = await self.adapter.run("positions")
        parsed = parse_positions(result.stdout)
        jobs = [
            Job(
                id=item.id,
                title=item.title,
                status=item.status,
                label=item.label,
                meta=list(item.meta),
                stats=JobStats(
                    viewed=item.viewed,
                    chatted=item.chatted,
                    interested=item.interested,
                ),
            )
            for item in parsed.jobs
        ]
        return JobListResponse(jobs=jobs, remote_total=parsed.remote_total)

    async def list_candidates_for_job(self, job_id: str) -> CandidateListResponse:
        jobs = await self.list_jobs()
        job = next((item for item in jobs.jobs if item.id == job_id), None)
        if job is None:
            raise LookupError(f"未找到岗位 ID：{job_id}")
        result = await self.adapter.run("list")
        parsed = parse_candidates(result.stdout)
        matching = [
            item
            for item in parsed.candidates
            if item.job.strip() == job.title.strip()
        ]
        return CandidateListResponse(
            job_id=job.id,
            job_title=job.title,
            candidates=[
                Candidate(
                    name=item.name,
                    job=item.job,
                    time=item.time,
                    message=item.message,
                    unread_count=item.unread_count,
                )
                for item in matching
            ],
            remote_total=len(matching),
            unread_total=sum(item.unread_count > 0 for item in matching),
        )

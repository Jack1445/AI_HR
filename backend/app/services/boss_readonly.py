from functools import lru_cache
import json
from datetime import date
import time

from app.adapters.boss_cli import BossCliAdapter
from app.core.config import get_settings
from app.parsers.boss_cli_output import BossCliOutputError, ParsedCandidate, parse_candidates, parse_positions
from app.schemas.recruiting import (
    Candidate,
    CandidateListResponse,
    Job,
    JobListResponse,
    JobStats,
)
from app.services.diagnostics import DiagnosticLog


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
        self.history_summary: dict = {}

    async def list_jobs(
        self,
        *,
        debug: bool = False,
        diagnostic_log: DiagnosticLog | None = None,
    ) -> JobListResponse:
        if debug or diagnostic_log is not None:
            result = await self.adapter.run("positions", debug=debug, diagnostic_log=diagnostic_log)
        else:
            result = await self.adapter.run("positions")
        parse_start = time.monotonic()
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
        if diagnostic_log is not None:
            diagnostic_log.write(
                "jobs.parsed",
                {"job_count": len(jobs), "remote_total": parsed.remote_total, "elapsed_seconds": time.monotonic() - parse_start},
            )
        return JobListResponse(jobs=jobs, remote_total=parsed.remote_total)

    async def list_candidates_for_job(
        self,
        job_id: str,
        *,
        debug: bool = False,
        diagnostic_log: DiagnosticLog | None = None,
    ) -> CandidateListResponse:
        jobs = await self.list_jobs(debug=debug, diagnostic_log=diagnostic_log)
        job = next((item for item in jobs.jobs if item.id == job_id), None)
        if job is None:
            raise LookupError(f"未找到岗位 ID：{job_id}")
        responses = await self.list_candidates_for_jobs(
            [job], debug=debug, diagnostic_log=diagnostic_log
        )
        return responses[job.id]

    async def list_candidates_for_jobs(
        self,
        jobs: list[Job],
        *,
        debug: bool = False,
        diagnostic_log: DiagnosticLog | None = None,
        history: bool = False,
        since: date | None = None,
    ) -> dict[str, CandidateListResponse]:
        """Read one communication snapshot and partition it by job title."""
        if not jobs:
            return {}
        if history:
            args = ["list", "--history", "--json"]
            if since:
                args.extend(["--since", since.isoformat()])
            result = await self.adapter.run(*args, debug=debug, diagnostic_log=diagnostic_log, timeout_seconds=660)
        elif debug or diagnostic_log is not None:
            result = await self.adapter.run("list", debug=debug, diagnostic_log=diagnostic_log)
        else:
            result = await self.adapter.run("list")
        parse_start = time.monotonic()
        if history:
            try:
                snapshot = json.loads(result.stdout)
                if snapshot.get("version") != 1 or snapshot.get("stop_reason") != "stable_bottom" or snapshot.get("since") != (since.isoformat() if since else None):
                    raise ValueError("历史列表没有完整加载或日期范围不符")
                rows = snapshot["rows"]
                if not isinstance(rows, list) or any(not isinstance(row, dict) or any(not isinstance(row.get(key), str) for key in ("sourceId", "name", "job", "time", "message")) or not row["sourceId"].strip() or not row["name"] or type(row.get("legacyMatchUnique")) is not bool or type(row.get("unreadCount")) is not int for row in rows):
                    raise ValueError("候选人列表字段无效")
                if len({row['sourceId'] for row in rows}) != len(rows):
                    raise ValueError('BOSS 会话编号重复，无法保存该快照')
                if type(snapshot.get('scanned')) is not int or snapshot['scanned'] < len(rows) or type(snapshot.get('undated')) is not int or not 0 <= snapshot['undated'] <= len(rows):
                    raise ValueError('历史遍历统计无效')
                candidates = tuple(ParsedCandidate(name=r["name"], job=r["job"], time=r["time"], message=r["message"], unread_count=r["unreadCount"], source_id=r['sourceId'], legacy_match_unique=r['legacyMatchUnique']) for r in rows)
                titles = {job.title.strip() for job in jobs}
                self.history_summary = {"scanned": snapshot["scanned"], "in_range": len(rows), "undated": snapshot["undated"], "unidentified": snapshot.get('unidentified', 0), "unmatched": sum(r.job.strip() not in titles for r in candidates), "stop_reason": snapshot["stop_reason"]}
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                raise BossCliOutputError(f"历史沟通列表格式错误：{exc}") from exc
        else:
            candidates = parse_candidates(result.stdout).candidates
        responses = {
            job.id: self._candidates_for_job(job, candidates, diagnostic_log)
            for job in jobs
        }
        if diagnostic_log is not None:
            diagnostic_log.write("candidates.partitioned", {"candidate_count": len(candidates), **self.history_summary, "elapsed_seconds": time.monotonic() - parse_start})
        return responses

    @staticmethod
    def _candidates_for_job(
        job: Job,
        candidates: tuple[ParsedCandidate, ...],
        diagnostic_log: DiagnosticLog | None,
    ) -> CandidateListResponse:
        matching = [
            item
            for item in candidates
            if item.job.strip() == job.title.strip()
        ]
        response = CandidateListResponse(
            job_id=job.id,
            job_title=job.title,
            candidates=[
                Candidate(
                    name=item.name,
                    job=item.job,
                    time=item.time,
                    message=item.message,
                    unread_count=item.unread_count,
                    source_id=item.source_id,
                    legacy_match_unique=item.legacy_match_unique,
                )
                for item in matching
            ],
            remote_total=len(matching),
            unread_total=sum(item.unread_count > 0 for item in matching),
        )
        if diagnostic_log is not None:
            diagnostic_log.write(
                "candidates.parsed",
                {"job_id": job.id, "candidate_count": len(response.candidates)},
            )
        return response

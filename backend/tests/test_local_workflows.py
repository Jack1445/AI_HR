from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.db.models import ActionRecord, CandidateRecord, JobRecord
from app.schemas.local import ActionCreate, CandidateUpdate
from app.schemas.recruiting import Candidate, CandidateListResponse, Job, JobListResponse, JobStats
from app.services.actions import ActionService
from app.services.local_store import LocalStoreService
from app.services.matching import MatchingService
from app.services.resumes import ResumeService
from app.core.config import Settings


class FakeBoss:
    async def list_jobs(self):
        return JobListResponse(jobs=[Job(id="remote-job", title="Python 工程师", status="active", label="", meta=["Python"], stats=JobStats(viewed=1, chatted=1, interested=0))], remote_total=1)

    async def list_candidates_for_job(self, job_id: str):
        return CandidateListResponse(job_id=job_id, job_title="Python 工程师", candidates=[Candidate(name="张三", job="Python 工程师", time="刚刚", message="熟悉 Python", unread_count=1)], remote_total=1, unread_total=1)


def make_db() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return Session(engine)


def test_sync_is_idempotent_and_preserves_local_stage() -> None:
    db = make_db()
    service = LocalStoreService(db, FakeBoss())
    import asyncio

    first = asyncio.run(service.sync())
    job = db.scalar(select(JobRecord))
    candidate = db.scalar(select(CandidateRecord))
    assert first.status == "success"
    assert job is not None and candidate is not None
    service.update_candidate(candidate.id, CandidateUpdate(stage="interviewing"))
    second = asyncio.run(service.sync())
    assert second.status == "success"
    assert db.query(JobRecord).count() == 1
    assert db.query(CandidateRecord).count() == 1
    assert db.scalar(select(CandidateRecord).where(CandidateRecord.id == candidate.id)).stage == "interviewing"


def test_confirmed_boss_action_is_blocked_by_default() -> None:
    db = make_db()
    candidate = CandidateRecord(remote_id="c1", name="张三")
    db.add(candidate)
    db.commit()
    service = ActionService(db, Settings(boss_enable_writes=False))
    import asyncio

    action = service.create(ActionCreate(action_type="send_message", candidate_id=candidate.id, payload={"text": "您好"}))
    result = asyncio.run(service.confirm(action.id))
    assert result.status == "blocked"
    assert db.scalar(select(ActionRecord).where(ActionRecord.id == action.id)).status == "blocked"


def test_action_stage_is_allowlisted() -> None:
    db = make_db()
    candidate = CandidateRecord(remote_id="c1", name="张三")
    db.add(candidate)
    db.commit()
    service = ActionService(db, Settings(boss_enable_writes=False))
    import pytest

    with pytest.raises(ValueError):
        service.create(ActionCreate(action_type="candidate_stage", candidate_id=candidate.id, payload={"stage": "evil"}))


def test_same_resume_bytes_are_safe_for_two_candidates(tmp_path) -> None:
    db = make_db()
    first = CandidateRecord(remote_id="c1", name="甲")
    second = CandidateRecord(remote_id="c2", name="乙")
    db.add_all([first, second])
    db.commit()
    service = ResumeService(db, Settings())
    service.root = tmp_path
    one = service.import_file(first.id, "resume.txt", "text/plain", b"same resume")
    two = service.import_file(second.id, "resume.txt", "text/plain", b"same resume")
    assert one.id != two.id
    assert one.sha256 == two.sha256


def test_matching_result_marks_missing_evidence_as_unknown() -> None:
    db = make_db()
    job = JobRecord(remote_id="j1", title="Python 工程师", meta_json='["Python", "英语"]')
    candidate = CandidateRecord(remote_id="c1", name="张三", profile_json='{"skills":["Python"]}')
    db.add_all([job, candidate])
    db.commit()
    result = MatchingService(db).analyze(candidate.id, job.id)
    statuses = {item["status"] for item in result.must_haves}
    assert result.provider == "deterministic"
    assert "unknown" in statuses

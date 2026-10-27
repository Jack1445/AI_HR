import asyncio

from sqlalchemy import create_engine, select

from app.core.json_utils import dumps, loads
from app.db.base import Base
from app.db.models import CandidateRecord, JobCandidateRecord, JobRecord, TimelineEventRecord
from app.db.session import SessionLocal
from app.schemas.recruiting import Candidate, CandidateListResponse, Job, JobListResponse, JobStats
from app.services.local_store import LocalStoreService, _fingerprint


class SnapshotBoss:
    def __init__(self, jobs, rows):
        self.jobs, self.rows = jobs, rows

    async def list_jobs(self, **kwargs):
        return JobListResponse(jobs=self.jobs, remote_total=len(self.jobs))

    async def list_candidates_for_jobs(self, jobs, **kwargs):
        return {j.id: CandidateListResponse(job_id=j.id, job_title=j.title, candidates=self.rows, remote_total=len(self.rows), unread_total=0) for j in jobs}


def test_identity_upgrade_across_same_title_jobs_uses_production_session():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as db:
        assert db.autoflush is False
        jobs = [Job(id=f'job-{i}', title='同名岗位', status='active', label='', meta=[], stats=JobStats(viewed=0, chatted=0, interested=0)) for i in range(2)]
        db.add_all([JobRecord(remote_id=j.id, title=j.title) for j in jobs])
        person = CandidateRecord(remote_id=_fingerprint('candidate', '旧候选人', '同名岗位'), name='旧候选人', owner='人工负责人', source_snapshot=dumps({'job': '同名岗位'}))
        db.add(person)
        db.commit()
        old_id = person.id
        rows = [Candidate(name=person.name, job='同名岗位', source_id='123-0', time='10月01日', message='测试消息', unread_count=0)]
        store = LocalStoreService(db, SnapshotBoss(jobs, rows))
        for _ in range(2):
            result = asyncio.run(store.sync())
            assert result.verification_ids == [old_id]
            assert db.query(CandidateRecord).count() == 1
            assert db.query(JobCandidateRecord).count() == 2
            assert db.query(TimelineEventRecord).count() == 2
            assert db.get(CandidateRecord, old_id).owner == '人工负责人'
            assert loads(db.get(CandidateRecord, old_id).source_snapshot, {})['source_id'] == '123-0'


def test_repeated_snapshot_rows_do_not_duplicate_pending_relations_or_events():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as db:
        jobs = [Job(id='job', title='测试岗位', status='active', label='', meta=[], stats=JobStats(viewed=0, chatted=0, interested=0))]
        row = Candidate(name='测试候选人', job='测试岗位', source_id='456-0', time='10月01日', message='原始消息', unread_count=0)
        # An existing person is linked to this job for the first time. No INSERT
        # of a new person should accidentally flush pending relations for us.
        db.add(CandidateRecord(remote_id=_fingerprint('boss-chat', row.source_id), name=row.name))
        db.commit()
        store = LocalStoreService(db, SnapshotBoss(jobs, [row, row, row]))
        for _ in range(2):
            assert len(asyncio.run(store.sync()).verification_ids) == 1
            assert db.query(JobCandidateRecord).count() == 1
            assert db.query(TimelineEventRecord).count() == 1
        row.message = '更新消息'
        asyncio.run(store.sync())
        assert db.query(JobCandidateRecord).count() == 1
        assert db.query(TimelineEventRecord).count() == 2
        assert db.scalar(select(JobCandidateRecord)).last_message == '更新消息'

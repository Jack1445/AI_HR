import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select

from app.core.greeting_identity import identity as greeting_identity
from app.db.base import Base
from app.db.models import CandidateRecord, RecommendedCandidateRecord, RecommendationGreetingLedgerRecord
from app.db.session import SessionLocal
from app.schemas.recruiting import Candidate, CandidateListResponse, Job, JobListResponse, JobStats
from app.services.discovery import DiscoveryService
from app.services import discovery
from app.services.local_store import LocalStoreService
from app.services.recommendation_scope import build_active_recommendation_index, recommendation_identity_for_chat


JOB_LABEL = '测试岗位 _ 北京 100-200元/天'


def add_recommendation(db, *, name, geek_id, greeted=False):
    row = RecommendedCandidateRecord(
        identity_key=f'identity-{geek_id}', source_job=JOB_LABEL,
        person_json=json.dumps({'name': name, 'geekId': geek_id}),
    )
    db.add(row)
    if greeted:
        db.add(RecommendationGreetingLedgerRecord(
            id=greeting_identity(DiscoveryService.job_key(JOB_LABEL), geek_id),
            batch_id='test', status='sent',
        ))
    db.commit()
    return row


class SnapshotBoss:
    def __init__(self, rows):
        self.rows = rows
        self.history_calls = 0
        self.history_summary = {}

    async def list_jobs(self, **kwargs):
        return JobListResponse(jobs=[Job(
            id='job-1', title='测试岗位', status='active', label='', meta=[],
            stats=JobStats(viewed=0, chatted=0, interested=0),
        )], remote_total=1)

    async def list_candidates_for_jobs(self, jobs, **kwargs):
        self.history_calls += 1
        return {job.id: CandidateListResponse(
            job_id=job.id, job_title=job.title, candidates=self.rows,
        ) for job in jobs}


def run_immediate(coroutine):
    # The fake BOSS methods complete synchronously at each await.
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError('Synthetic sync unexpectedly awaited external I/O')


def test_sync_only_imports_confirmed_greetings_and_skips_empty_scope():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as db:
        boss = SnapshotBoss([
            Candidate(name='已招呼', job='测试岗位', source_id='chat-1', time='今天', message='你好', unread_count=0),
            Candidate(name='未招呼', job='测试岗位', source_id='chat-2', time='今天', message='你好', unread_count=0),
        ])
        add_recommendation(db, name='未招呼', geek_id='geek-2')
        store = LocalStoreService(db, boss)
        empty = run_immediate(store.sync())
        assert boss.history_calls == 0
        assert empty.verification_ids == []
        assert db.scalars(select(CandidateRecord)).all() == []

        add_recommendation(db, name='已招呼', geek_id='geek-1', greeted=True)
        synced = run_immediate(store.sync())
        assert boss.history_calls == 1
        assert len(synced.verification_ids) == 1
        assert [person.name for person in store.list_candidates().candidates] == ['已招呼']
        assert [person.name for person in db.scalars(select(CandidateRecord))] == ['已招呼']

        class VerifyAdapter:
            calls = []

            async def run(self, *args):
                self.calls.append(args)
                return SimpleNamespace(stdout=json.dumps({'version': 1, 'results': [{
                    'id': synced.verification_ids[0], 'status': 'unknown',
                    'evidence': None, 'checked_at': '2026-10-28T00:00:00Z',
                }]}))

        adapter = VerifyAdapter()
        original_settings = discovery.get_settings
        discovery.get_settings = lambda: SimpleNamespace(automation_emergency_stop=False)
        try:
            run_immediate(DiscoveryService(db, adapter).classify(synced.verification_ids, accept_incoming_resumes=True))
        finally:
            discovery.get_settings = original_settings
        assert adapter.calls[0][-1] == '--accept-incoming-resumes'

        ledger = db.get(RecommendationGreetingLedgerRecord, greeting_identity(DiscoveryService.job_key(JOB_LABEL), 'geek-1'))
        ledger.status = 'unknown'
        db.commit()
        assert store.list_candidates().total == 0
        with pytest.raises(ValueError, match='已打招呼'):
            run_immediate(DiscoveryService(db, None).classify(synced.verification_ids))
    engine.dispose()


def test_ungreeted_namesake_remains_ambiguous():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as db:
        add_recommendation(db, name='同名', geek_id='geek-1', greeted=True)
        add_recommendation(db, name='同名', geek_id='geek-2')
        index = build_active_recommendation_index(db, greeted_only=True)
        assert recommendation_identity_for_chat(index, '同名', '测试岗位') is None
    engine.dispose()

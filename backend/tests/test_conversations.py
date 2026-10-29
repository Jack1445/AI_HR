import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes import conversations
from app.db.base import Base
from app.db.models import CandidateRecord, JobCandidateRecord, JobRecord, RecommendedCandidateRecord


@pytest.fixture
def db():
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, autoflush=False)
    with factory() as session:
        job = JobRecord(id='job-1', remote_id='remote-job', title='岗位 A')
        person = CandidateRecord(id='person-1', remote_id='boss-conversation-17', name='同名人选')
        session.add_all([job, person])
        session.flush()
        session.add(RecommendedCandidateRecord(identity_key='recommendation-1', person_json=json.dumps({
            'name': '同名人选', 'baseInfo': '23岁 / 28年应届生 / 硕士 / 刚刚活跃'}), source_job='岗位 A'))
        session.add(JobCandidateRecord(job_id=job.id, candidate_id=person.id, remote_job_text='岗位 A',
                                       remote_time='10月29日', source_snapshot=json.dumps({'recommendation_identity': 'recommendation-1'})))
        session.commit()
        yield session
    engine.dispose()


def test_conversation_requires_exact_local_relation(db):
    assert conversations.target_for(db, 'person-1', 'job-1') == {
        'id': 'person-1', 'sourceId': 'boss-conversation-17', 'name': '同名人选', 'job': '岗位 A',
        'recentTime': '10月29日', 'baseInfo': '23岁 / 28年应届生 / 硕士 / 刚刚活跃'}
    with pytest.raises(HTTPException) as exc:
        conversations.target_for(db, 'person-1', 'another-job')
    assert exc.value.status_code == 404


def test_manual_send_confirms_target_and_never_repeats_same_request(db, monkeypatch):
    calls = []

    class FakeAdapter:
        async def run(self, *args):
            calls.append(args)
            return SimpleNamespace(stdout=json.dumps({'messages': [{'from': 'myself', 'text': '你好', 'time': '现在'}]}))

    monkeypatch.setattr(conversations, 'get_boss_cli_adapter', lambda: FakeAdapter())
    monkeypatch.setattr(conversations, 'get_settings', lambda: SimpleNamespace(automation_emergency_stop=False))
    payload = conversations.SendText(job_id='job-1', text='你好', request_id=uuid4(), confirmed=True)
    first = asyncio.run(conversations.send_conversation('person-1', payload, db))
    second = asyncio.run(conversations.send_conversation('person-1', payload, db))
    assert first['status'] == second['status'] == 'success'
    assert len(calls) == 1
    assert calls[0][0:2] == ('conversation', '--target')
    assert json.loads(calls[0][2])['sourceId'] == 'boss-conversation-17'
    assert calls[0][3] == '--text=你好'
    with pytest.raises(HTTPException) as exc:
        asyncio.run(conversations.send_conversation('person-1', payload.model_copy(update={'confirmed': False}), db))
    assert exc.value.status_code == 400 and len(calls) == 1

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import Settings
from app.db.base import Base
from app.db.models import (RecommendedCandidateRecord, RecommendationJobRecord,
    RecommendationGreetingBatchRecord as Batch, RecommendationGreetingLedgerRecord as Ledger)
from app.db.session import get_db
from app.services.discovery import DiscoveryService
from app.services import recommendation_greetings as greet


@pytest.fixture
def store(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    settings = Settings(boss_enable_writes=False, automation_emergency_stop=False)
    monkeypatch.setattr(greet, 'get_settings', lambda: settings)
    label = '测试岗位 · 北京 100-200元/天'
    job = DiscoveryService.job_key(label)
    with factory() as db:
        db.add(RecommendationJobRecord(id=job, label=label, available=True))
        for i in range(3):
            db.add(RecommendedCandidateRecord(id=f'local-{i}', identity_key=f'identity-{i}', source_job=label,
                person_json=json.dumps({'geekId': f'geek-{i}', 'name': '同名测试', 'baseInfo': f'{20+i}岁 / 本科',
                    'salary': '', 'expect': '', 'experience': '', 'advantage': '', 'highlights': [],
                    'canGreet': True, 'hasHistoryChat': False, 'hasViewed': False})))
        db.commit()
    yield factory, job, settings
    engine.dispose()


def payload(job, ids=('local-0', 'local-1')):
    return greet.GreetingRequest(request_id=uuid4(), job_key=job, candidate_ids=list(ids), confirmed=True)


class FakeBoss:
    def __init__(self, outcomes=None, after=None):
        self.calls, self.outcomes, self.after = [], list(outcomes or []), after

    async def run(self, *args, **kwargs):
        self.calls.append(args)
        outcome = self.outcomes.pop(0) if self.outcomes else 'sent'
        if self.after:
            self.after()
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, dict):
            return SimpleNamespace(stdout=json.dumps(dict(version=1, geek_id=args[2], job_label=args[8], detail='fixture', **outcome)))
        return SimpleNamespace(stdout=json.dumps(dict(version=1, geek_id=args[2], job_label=args[8],
            attempted=outcome in ('sent', 'clicked'), outcome=outcome, detail='fixture result')))


def run(store, boss, request=None):
    factory, job, _ = store
    with factory() as db:
        batch = greet.create_batch(db, request or payload(job))
        batch_id = batch.id
    asyncio.run(greet.execute_batch(batch_id, factory, boss))
    with factory() as db:
        return greet.view(db.get(Batch, batch_id))


def test_only_selected_and_same_name_safe(store):
    factory, job, _ = store
    boss = FakeBoss()
    result = run(store, boss, payload(job, ('local-1',)))
    assert result['sent'] == 1 and result['total'] == 1
    assert boss.calls[0][0] == 'recommend-greet'
    assert boss.calls[0][2] == 'geek-1'
    assert boss.calls[0][6] == '21岁 / 本科'
    assert len(boss.calls) == 1


def test_daily_count_uses_beijing_day_and_confirmed_sends_only(store):
    factory, _, _ = store
    with factory() as db:
        db.add_all([
            Ledger(id='previous-day', batch_id='test', status='sent', updated_at=datetime(2026, 10, 28, 15, 59, tzinfo=timezone.utc)),
            Ledger(id='today-1', batch_id='test', status='sent', updated_at=datetime(2026, 10, 28, 16, 0, tzinfo=timezone.utc)),
            Ledger(id='today-2', batch_id='test', status='sent', updated_at=datetime(2026, 10, 29, 0, 0, tzinfo=timezone.utc)),
            Ledger(id='already', batch_id='test', status='already', updated_at=datetime(2026, 10, 29, 0, 1, tzinfo=timezone.utc)),
            Ledger(id='unknown', batch_id='test', status='unknown', updated_at=datetime(2026, 10, 29, 0, 2, tzinfo=timezone.utc)),
        ])
        db.commit()
        assert greet.daily_greeting_count(db, datetime(2026, 10, 29, 3, 0, tzinfo=timezone.utc)) == {'date': '2026-10-29', 'count': 2, 'limit': 200}
        assert greet.daily_greeting_count(db, datetime(2026, 10, 29, 16, 0, tzinfo=timezone.utc)) == {'date': '2026-10-30', 'count': 0, 'limit': 200}


def test_idempotent_request_and_cross_batch_no_duplicate(store):
    factory, job, _ = store
    request = payload(job)
    boss = FakeBoss()
    run(store, boss, request)
    run(store, boss, request)
    result = run(store, boss)
    assert len(boss.calls) == 2
    assert result['already'] == 2
    with factory() as db:
        with pytest.raises(ValueError, match='请求编号'):
            greet.create_batch(db, request.model_copy(update={'candidate_ids': ['local-2']}))


@pytest.mark.parametrize('outcome', ['clicked', TimeoutError(), ValueError()])
def test_unknown_stops_and_never_retries(store, outcome):
    factory, job, _ = store
    boss = FakeBoss([outcome])
    result = run(store, boss)
    assert result['status'] == 'stopped'
    assert result['items'][1]['status'] == 'skipped'
    assert len(boss.calls) == 1
    second = run(store, boss, payload(job, ('local-0',)))
    assert second['items'][0]['status'] == 'unknown'
    assert len(boss.calls) == 1


def test_preflight_mismatch_can_be_retried_manually(store):
    boss = FakeBoss(['not_found', 'mismatch'])
    result = run(store, boss)
    assert result['completed'] == 2 and result['sent'] == 0
    assert result['status'] == 'completed'
    result = run(store, boss)
    assert result['sent'] == 2 and len(boss.calls) == 4


def test_platform_block_stops_remaining(store):
    boss = FakeBoss(['blocked'])
    result = run(store, boss)
    assert len(boss.calls) == 1
    assert result['items'][1]['status'] == 'skipped'


def test_rejection_after_click_is_never_repeated(store):
    _, job, _ = store
    boss = FakeBoss([dict(outcome='blocked', attempted=True)])
    run(store, boss)
    result = run(store, boss, payload(job, ('local-0',)))
    assert result['items'][0]['status'] == 'unknown'
    assert len(boss.calls) == 1


def test_reservation_committed_before_external_call(store):
    factory, job, _ = store
    def check():
        with factory() as db:
            assert db.get(Ledger, greet.identity(job, 'geek-0')).status == 'executing'
    run(store, FakeBoss(after=check), payload(job, ('local-0',)))


def test_emergency_stop_checked_between_people(store):
    _, _, settings = store
    result = run(store, FakeBoss(after=lambda: setattr(settings, 'automation_emergency_stop', True)))
    assert result['sent'] == 1
    assert result['items'][1]['status'] == 'skipped'


def test_job_deleted_missing_and_duplicate_identity_rejected(store):
    factory, job, settings = store
    with factory() as db:
        with pytest.raises(ValueError, match='不可用'):
            greet.create_batch(db, payload('wrong'))
        with pytest.raises(ValueError, match='已删除'):
            greet.create_batch(db, payload(job, ('missing',)))
        row = db.get(RecommendedCandidateRecord, 'local-0')
        row.source_job = 'different'
        db.commit()
        with pytest.raises(ValueError, match='不属于'):
            greet.create_batch(db, payload(job))
        row.source_job = db.get(RecommendationJobRecord, job).label
        row.person_json = db.get(RecommendedCandidateRecord, 'local-1').person_json
        db.commit()
        with pytest.raises(ValueError, match='重复'):
            greet.create_batch(db, payload(job))
        settings.automation_emergency_stop = True
        with pytest.raises(ValueError, match='紧急停止'):
            greet.create_batch(db, payload(job))


def test_restart_recovery_marks_unknown_without_replay(store):
    factory, job, _ = store
    with factory() as db:
        batch = greet.create_batch(db, payload(job))
        items = json.loads(batch.items_json)
        items[0]['status'] = 'executing'
        batch.items_json = json.dumps(items)
        batch.status = 'running'
        db.add(Ledger(id=greet.identity(job, 'geek-0'), batch_id=batch.id, status='executing'))
        db.commit()
        greet.recover_interrupted_greetings(db)
        result = greet.view(batch)
        assert result['status'] == 'interrupted'
        assert [i['status'] for i in result['items']] == ['unknown', 'skipped']
    boss = FakeBoss()
    result = run(store, boss)
    assert len(boss.calls) == 1 and boss.calls[0][2] == 'geek-1'


def test_confirm_required_and_cross_origin_denied(store, monkeypatch):
    from app.api.routes import recommendation_greetings as routes
    factory, job, _ = store
    app = FastAPI()
    app.include_router(routes.router)
    def database():
        with factory() as db:
            yield db
    app.dependency_overrides[get_db] = database
    async def no_external_call(_):
        routes.manual_read_lock.release()
    monkeypatch.setattr(routes, 'run_reserved', no_external_call)
    with TestClient(app) as client:
        data = payload(job).model_dump(mode='json')
        assert client.post('/api/recommendation-greetings', json={**data, 'confirmed': False}).status_code == 422
        assert client.post('/api/recommendation-greetings', json={**data, 'confirmed': 1}).status_code == 422
        assert client.post('/api/recommendation-greetings', json=data, headers={'Origin': 'https://untrusted.example'}).status_code == 403
        first = client.post('/api/recommendation-greetings', json=data)
        assert first.status_code == 202
        second = client.post('/api/recommendation-greetings', json=data)
        assert second.json()['id'] == first.json()['id']
        assert client.get('/api/recommendation-greetings').json()[0]['total'] == 2


def local_statuses(store, job_key=None):
    factory, job, _ = store
    with factory() as db:
        return {p.id: p.greeted for p in DiscoveryService(db, FakeBoss()).recommendations(job_key or job).candidates}


def test_greeted_column_tracks_confirmed_sends_and_survives_repeat(store):
    assert local_statuses(store) == {'local-0': False, 'local-1': False, 'local-2': False}
    run(store, FakeBoss(['sent', 'not_found']))
    assert local_statuses(store) == {'local-0': True, 'local-1': False, 'local-2': False}
    _, job, _ = store
    result = run(store, FakeBoss(), payload(job, ('local-0',)))
    assert result['items'][0]['status'] == 'already'
    assert local_statuses(store)['local-0'] is True


@pytest.mark.parametrize('outcome', ['already', 'clicked', 'blocked', 'mismatch', TimeoutError()])
def test_greeted_column_does_not_claim_unsent_or_uncertain_results(store, outcome):
    _, job, _ = store
    run(store, FakeBoss([outcome]), payload(job, ('local-0',)))
    assert local_statuses(store)['local-0'] is False


def test_greeted_column_restores_history_and_uses_job_plus_id(store):
    factory, job, _ = store
    # Simulate an existing ledger written before the new UI field was introduced.
    with factory() as db:
        db.add(Ledger(id=greet.identity(job, 'geek-0'), batch_id='historical', status='sent'))
        other_label = '另一个岗位 · 上海'
        other_job = DiscoveryService.job_key(other_label)
        db.add(RecommendationJobRecord(id=other_job, label=other_label, available=True))
        same_person = db.get(RecommendedCandidateRecord, 'local-0')
        db.add(RecommendedCandidateRecord(id='other-job-person', identity_key='other-identity', source_job=other_label, person_json=same_person.person_json))
        db.commit()
    assert local_statuses(store)['local-0'] is True
    assert local_statuses(store)['local-1'] is False  # Same name, different remote ID.
    assert local_statuses(store, other_job)['other-job-person'] is False


def test_greeted_column_can_be_saved_in_table_filters(store):
    from app.services.table_store import TableStore
    from app.schemas.tables import SaveConfig, TableConfig, TableView, ColumnConfig, FilterRule, SortRule
    factory, _, _ = store
    with factory() as db:
        table = TableStore(db, 'recommendations')
        state = table.state()
        config = TableConfig(views=[TableView(id='default', name='已打招呼', columns=[ColumnConfig(id='greeted')],
            filters=[FilterRule(field='greeted', op='eq', value='是')], sorts=[SortRule(field='greeted')])])
        table.save_config(SaveConfig(revision=state['revision'], config=config))
        assert table.state()['config']['views'][0]['filters'][0]['field'] == 'greeted'

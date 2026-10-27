import asyncio
import json
from datetime import date

import pytest
from sqlalchemy import create_engine, select
from app.db.session import SessionLocal

from app.adapters.boss_cli import BossCliResult
from app.db.base import Base
from app.db.models import CandidateRecord, CommunicationRecycleRecord
from app.parsers.boss_cli_output import BossCliOutputError
from app.services.boss_readonly import BossReadOnlyService
from app.services.local_store import LocalStoreService


class HistoryAdapter:
    def __init__(self):
        self.calls = []
        self.scope = list(range(37))
        self.stop_reason = 'stable_bottom'

    async def run(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args == ('positions',):
            output = '已读取 1 个职位（页面统计：共 1 个）。\n职位明细：\n1. 测试岗位｜状态:开放中｜标签:｜ID:10001'
        else:
            assert args[:3] == ('list', '--history', '--json')
            assert kwargs['timeout_seconds'] == 660
            output = json.dumps(dict(version=1, since=args[4] if '--since' in args else None, stop_reason=self.stop_reason, scanned=37, undated=0, rows=[dict(sourceId=f'chat-{i}', legacyMatchUnique=True, name=f'候选人{i}', job='测试岗位', time='10月01日', message='测试', unreadCount=0) for i in self.scope]))
        return BossCliResult(tuple(args), output, '', 0)


def test_history_sync_imports_more_than_ten_and_returns_only_current_scope():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    adapter = HistoryAdapter()
    with SessionLocal(bind=engine) as db:
        store = LocalStoreService(db, BossReadOnlyService(adapter))
        result = asyncio.run(store.sync(since=date(2026, 10, 1)))
        assert adapter.calls[1][0] == ('list', '--history', '--json', '--since', '2026-10-01')
        assert len(result.verification_ids) == 37
        assert store.list_candidates().total == 37
        assert result.history_summary['scanned'] == 37
        person = db.scalar(select(CandidateRecord).where(CandidateRecord.name == '候选人0'))
        person.owner = '人工标注'
        db.commit()
        adapter.scope = [1, 2]
        narrowed = asyncio.run(store.sync(since=date(2026, 10, 25)))
        assert len(narrowed.verification_ids) == 2
        assert person.id not in narrowed.verification_ids
        assert store.list_candidates().total == 37, 'narrowing range must preserve previous records'
        assert db.get(CandidateRecord, person.id).owner == '人工标注'
        adapter.scope = []
        empty = asyncio.run(store.sync(since=date(2026, 10, 26)))
        assert empty.verification_ids == []
        assert store.list_candidates().total == 37
        adapter.stop_reason = 'timeout'
        with pytest.raises(BossCliOutputError):
            asyncio.run(store.sync())
        assert store.list_candidates().total == 37


def test_sync_preserves_recycle_exclusions():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    from app.services.local_store import _fingerprint
    with SessionLocal(bind=engine) as db:
        db.add(CommunicationRecycleRecord(remote_id=_fingerprint('candidate', '候选人0', '测试岗位'), name='候选人0', source_job='测试岗位'))
        db.commit()
        store = LocalStoreService(db, BossReadOnlyService(HistoryAdapter()))
        result = asyncio.run(store.sync())
        assert len(result.verification_ids) == 36
        assert store.list_candidates().total == 36


def test_date_query_validation_and_forwarding():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api.routes.local_data import service
    from app.schemas.local import SyncResponse

    class Stub:
        diagnostic_log_path = None
        calls = []

        async def sync(self, scope, **kwargs):
            self.calls.append((scope, kwargs))
            return SyncResponse(sync_id='test', scope=scope, status='success', since=kwargs['since'])

    stub = Stub()
    app.dependency_overrides[service] = lambda: stub
    try:
        client = TestClient(app)
        assert client.post('/api/local/sync?since=2020-10-01').json()['since'] == '2020-10-01'
        assert stub.calls[0][1]['since'] == date(2020, 10, 1)
        for invalid in ['2999-01-01', '2026-02-30', 'bad']:
            assert client.post(f'/api/local/sync?since={invalid}').status_code == 422
        assert len(stub.calls) == 1
    finally:
        app.dependency_overrides.pop(service, None)

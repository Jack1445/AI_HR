import asyncio
import json

from sqlalchemy import create_engine, select
from app.db.session import SessionLocal

from app.adapters.boss_cli import BossCliResult
from app.core.json_utils import dumps, loads
from app.db.base import Base
from app.db.models import CandidateRecord, CommunicationRecycleRecord
from app.services.boss_readonly import BossReadOnlyService
from app.services.discovery import DiscoveryService
from app.services.local_store import LocalStoreService, _fingerprint


class IdentityAdapter:
    def __init__(self, ids):
        self.ids = ids
        self.calls = []

    async def run(self, *args, **kwargs):
        self.calls.append(args)
        if args == ('positions',):
            output = '已读取 1 个职位（页面统计：共 1 个）。\n职位明细：\n1. 测试岗位｜状态:开放中｜标签:｜ID:10001'
        elif args[0] == 'classify':
            targets = json.loads(args[2])
            output = json.dumps(dict(version=1, results=[dict(id=t['id'], status='unknown', evidence=None, checked_at='2026-10-26T08:00:00Z', error='测试未知状态') for t in targets]))
        else:
            output = json.dumps(dict(version=1, since=None, stop_reason='stable_bottom', scanned=len(self.ids), undated=0, unidentified=0, rows=[dict(sourceId=i, legacyMatchUnique=len(self.ids) == 1, name='同名人选', job='测试岗位', time='10月01日', message=f'消息-{i}', unreadCount=0) for i in self.ids]))
        return BossCliResult(args, output, '', 0)


def database():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    return SessionLocal(bind=engine)


def test_same_name_and_job_keep_distinct_records_and_verification_ids():
    with database() as db:
        adapter = IdentityAdapter(['786184743-0', '786172528-0'])
        store = LocalStoreService(db, BossReadOnlyService(adapter))
        first = asyncio.run(store.sync())
        people = db.scalars(select(CandidateRecord)).all()
        assert len(people) == 2 and len(first.verification_ids) == 2
        by_source = {loads(p.source_snapshot, {})['source_id']: p.id for p in people}
        people[0].owner = '仅第一人'
        db.commit()
        adapter.ids.reverse()
        second = asyncio.run(store.sync())
        assert set(first.verification_ids) == set(second.verification_ids)
        assert store.list_candidates().total == 2
        asyncio.run(DiscoveryService(db, adapter).classify(second.verification_ids))
        targets = json.loads(adapter.calls[-1][2])
        assert {t['sourceId']: t['id'] for t in targets} == by_source
        assert db.get(CandidateRecord, people[0].id).owner == '仅第一人'
        assert db.get(CandidateRecord, people[1].id).owner == ''


def test_unique_legacy_record_upgrades_in_place_and_preserves_annotations():
    with database() as db:
        old = CandidateRecord(remote_id=_fingerprint('candidate', '同名人选', '测试岗位'), name='同名人选', owner='保留负责人', stage='interviewing', profile_json=dumps({'keep': '我的标注'}), source_snapshot=dumps({'job': '测试岗位'}))
        db.add(old); db.commit()
        old_id = old.id
        result = asyncio.run(LocalStoreService(db, BossReadOnlyService(IdentityAdapter(['111-0']))).sync())
        assert result.verification_ids == [old_id]
        assert db.query(CandidateRecord).count() == 1
        assert old.remote_id == _fingerprint('boss-chat', '111-0')
        assert old.owner == '保留负责人' and old.stage == 'interviewing'
        assert loads(old.profile_json, {})['keep'] == '我的标注'


def test_ambiguous_legacy_annotation_is_not_assigned_to_either_new_person():
    with database() as db:
        old = CandidateRecord(remote_id=_fingerprint('candidate', '同名人选', '测试岗位'), name='同名人选', owner='旧标注', source_snapshot=dumps({'job': '测试岗位'}))
        db.add(old); db.commit()
        store = LocalStoreService(db, BossReadOnlyService(IdentityAdapter(['111-0', '222-0'])))
        result = asyncio.run(store.sync())
        assert len(result.verification_ids) == 2 and old.id not in result.verification_ids
        assert db.query(CandidateRecord).count() == 3
        assert result.history_summary['ambiguous_legacy'] == 1
        assert old.owner == '旧标注'
        assert '多个同名会话' in store.detail(old.id).communication_error
        assert all(db.get(CandidateRecord, i).owner == '' for i in result.verification_ids)


def test_new_tombstone_excludes_only_its_boss_id_not_the_same_name():
    with database() as db:
        db.add(CommunicationRecycleRecord(remote_id=_fingerprint('boss-chat', '111-0'), name='同名人选', source_job='测试岗位'))
        db.commit()
        store = LocalStoreService(db, BossReadOnlyService(IdentityAdapter(['111-0', '222-0'])))
        result = asyncio.run(store.sync())
        assert len(result.verification_ids) == 1
        person = db.get(CandidateRecord, result.verification_ids[0])
        assert loads(person.source_snapshot, {})['source_id'] == '222-0'

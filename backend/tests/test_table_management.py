import asyncio
from datetime import datetime
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from app.db.models import (CandidateRecord, RecommendedCandidateRecord, RecommendationFirstCaptureRecord, RecommendedResumeRecord, CommunicationRecycleRecord, JobCandidateRecord, CandidateNoteRecord)
from app.schemas.tables import SaveConfig, SaveCells, TableConfig, TableField, TableView, ColumnConfig
from app.services.table_store import TableStore
from app.services.discovery import DiscoveryService
from app.services.local_store import LocalStoreService
from app.api.routes.tables import remove_communication
from test_local_workflows import make_db, FakeBoss
from test_discovery import Adapter, ScreenshotAdapter, recommendation
from app.core.config import Settings


def configure(store, kind='select'):
    initial = store.state()
    config = TableConfig(fields=[TableField(id='custom_focus', name='关注级别', type=kind, options=['重点', '待定'] if kind in ('select', 'multi') else [])], views=[TableView(id='default', name='全部记录', columns=[ColumnConfig(id='name'), ColumnConfig(id='custom_focus')], order=[])])
    return store.save_config(SaveConfig(revision=initial['revision'], config=config))


def test_config_revision_and_custom_data_survive_reload_and_sync():
    db = make_db()
    local = LocalStoreService(db, FakeBoss())
    asyncio.run(local.sync())
    person = db.scalar(select(CandidateRecord))
    store = TableStore(db, 'communications')
    state = configure(store)
    store.save_cells(SaveCells(record_ids=[person.id], field_id='custom_focus', value='重点'))
    asyncio.run(local.sync())
    reloaded = TableStore(db, 'communications').state()
    assert reloaded['values'][person.id]['custom_focus'] == '重点'
    assert reloaded['config']['fields'][0]['name'] == '关注级别'
    with pytest.raises(HTTPException) as exc:
        store.save_config(SaveConfig(revision=0, config=TableConfig.model_validate(state['config'])))
    assert exc.value.status_code == 409
    assert store.state()['values'] == reloaded['values']


@pytest.mark.parametrize('kind,bad,good', [('number', '30', 30), ('number', True, 0), ('checkbox', 'true', False), ('date', '2026-02-30', '2026-10-26'), ('select', '不存在', '重点'), ('multi', ['重点', '未知'], ['重点']), ('text', 42, '本地内容')])
def test_types_validate_and_batch_is_atomic(kind, bad, good):
    db = make_db()
    person = CandidateRecord(remote_id='test', name='测试')
    db.add(person); db.commit()
    store = TableStore(db, 'communications')
    configure(store, kind)
    with pytest.raises(HTTPException):
        store.save_cells(SaveCells(record_ids=[person.id], field_id='custom_focus', value=bad))
    assert store.state()['values'] == {}
    with pytest.raises(HTTPException):
        store.save_cells(SaveCells(record_ids=[person.id, 'missing'], field_id='custom_focus', value=good))
    assert store.state()['values'] == {}
    store.save_cells(SaveCells(record_ids=[person.id], field_id='custom_focus', value=good))
    assert store.state()['values'][person.id]['custom_focus'] == good
    with pytest.raises(HTTPException):
        store.save_cells(SaveCells(record_ids=[person.id], field_id='name', value='改写系统姓名'))
    assert db.get(CandidateRecord, person.id).name == '测试'


def test_deleting_field_clears_values_and_rejects_stale_references():
    db = make_db()
    person = CandidateRecord(remote_id='test', name='测试')
    db.add(person); db.commit()
    store = TableStore(db, 'communications')
    state = configure(store)
    store.save_cells(SaveCells(record_ids=[person.id], field_id='custom_focus', value='重点'))
    invalid = TableConfig.model_validate(state['config']); invalid.fields = []
    with pytest.raises(HTTPException):
        store.save_config(SaveConfig(revision=state['revision'], config=invalid))
    assert store.state()['values'][person.id]['custom_focus'] == '重点'
    store.save_config(SaveConfig(revision=state['revision'], config=TableConfig()))
    assert store.state()['values'] == {}


def test_comm_delete_removes_all_relations_and_prevents_next_sync():
    db = make_db()
    local = LocalStoreService(db, FakeBoss())
    asyncio.run(local.sync())
    person = db.scalar(select(CandidateRecord)); key = person.remote_id; person_id = person.id
    db.add(CandidateNoteRecord(candidate_id=person_id, content='to delete'))
    db.commit()
    store = TableStore(db, 'communications'); configure(store)
    store.save_cells(SaveCells(record_ids=[person_id], field_id='custom_focus', value='重点'))
    remove_communication(db, person_id)
    assert db.get(CandidateRecord, person_id) is None
    assert not db.scalars(select(JobCandidateRecord)).all()
    assert not db.scalars(select(CandidateNoteRecord)).all()
    assert store.state()['values'] == {}
    asyncio.run(local.sync())
    assert not db.scalars(select(CandidateRecord)).all()
    # Releasing the source key alone does not restore personal data or run BOSS.
    db.delete(db.get(CommunicationRecycleRecord, key)); db.commit()
    assert not db.scalars(select(CandidateRecord)).all()
    asyncio.run(local.sync())
    assert len(db.scalars(select(CandidateRecord)).all()) == 1


def test_retrieval_date_uses_first_success_and_purges_on_delete(tmp_path, monkeypatch):
    from app.services import discovery
    monkeypatch.setattr(discovery, 'get_settings', lambda: Settings(data_dir=str(tmp_path)))
    db = make_db()
    adapter = Adapter(recommendation(1)); svc = DiscoveryService(db, adapter)
    person = asyncio.run(svc.read_recommendations(svc.remember_job('测试岗位', available=True).id)).candidates[0]
    assert person.first_retrieved_at is None
    svc.adapter = ScreenshotAdapter(dict(version=1, job_label='测试岗位', geek_id=person.geekId, name=person.name, captured_at='2026-10-21T16:30:00Z'))
    asyncio.run(svc.capture_resume(person.geekId, person.id))
    first = svc.recommendations().candidates[0].first_retrieved_at
    svc.adapter.body['captured_at'] = '2026-10-26T06:00:00Z'
    asyncio.run(svc.capture_resume(person.geekId, person.id))
    current = svc.recommendations().candidates[0]
    assert current.first_retrieved_at == first
    assert current.online_resume.captured_at != first
    # Simulate legacy data with no first-capture mapping: backfill earliest capture.
    db.delete(db.get(RecommendationFirstCaptureRecord, person.id)); db.commit()
    assert svc.recommendations().candidates[0].first_retrieved_at == first
    store = TableStore(db, 'recommendations'); configure(store)
    store.save_cells(SaveCells(record_ids=[person.id], field_id='custom_focus', value='重点'))
    svc.delete_recommendation(person.id)
    assert store.state()['values'] == {}
    assert db.get(RecommendationFirstCaptureRecord, person.id) is None
    assert not db.scalars(select(RecommendedResumeRecord)).all()


def test_candidate_pagination_reports_full_total_and_first_sync_date():
    db = make_db()
    db.add_all(CandidateRecord(remote_id=f'test-{i}', name=f'测试{i}') for i in range(505)); db.commit()
    store = LocalStoreService(db)
    first = store.list_candidates(limit=500); second = store.list_candidates(limit=500, offset=500)
    assert first.total == second.total == 505
    assert len(first.candidates) == 500 and len(second.candidates) == 5
    assert all(c.created_at for c in first.candidates)
    assert len({c.id for c in first.candidates + second.candidates}) == 505

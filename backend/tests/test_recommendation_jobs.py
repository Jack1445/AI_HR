import asyncio
import json
import pytest
from sqlalchemy import select
from test_discovery import database, Adapter, recommendation, ScreenshotAdapter
from app.services.discovery import DiscoveryService
from app.db.models import RecommendedCandidateRecord, RecommendationRecycleRecord, RecommendationJobRecord
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.discovery import RecommendedPerson
from app.core.config import Settings


def batch(label, count=1):
    return {**recommendation(count), 'job_label': label, 'limit': 50}


def test_twenty_bound_and_wrong_job_result_never_written():
    db = database(); adapter = Adapter(batch('岗位 A', 20)); svc = DiscoveryService(db, adapter)
    job = svc.remember_job('岗位 A', available=True)
    result = asyncio.run(svc.read_recommendations(job.id))
    assert len(result.added_ids) == 20 and len(result.candidates) == 20
    assert adapter.calls[0][1:3] == ('--limit', '20')
    assert adapter.calls[0][-2:] == ('--job-label', '岗位 A')
    adapter.body = batch('岗位 A', 21)
    with pytest.raises(BossCliOutputError): asyncio.run(svc.read_recommendations(job.id))
    adapter.body = batch('岗位 B', 1)
    with pytest.raises(BossCliOutputError, match='岗位与所选岗位不一致'): asyncio.run(svc.read_recommendations(job.id))
    assert db.query(RecommendedCandidateRecord).count() == 20


def test_same_person_separate_jobs_dedup_delete_and_restore(tmp_path, monkeypatch):
    from app.services import discovery
    monkeypatch.setattr(discovery, 'get_settings', lambda: Settings(data_dir=str(tmp_path)))
    db = database(); adapter = Adapter(batch('岗位 A')); svc = DiscoveryService(db, adapter)
    a = svc.remember_job('岗位 A', available=True); b = svc.remember_job('岗位 B', available=True)
    first = asyncio.run(svc.read_recommendations(a.id)).candidates[0]
    adapter.body = batch('岗位 B')
    second = asyncio.run(svc.read_recommendations(b.id)).candidates[0]
    assert first.id != second.id and first.name == second.name and first.baseInfo == second.baseInfo
    assert len(svc.recommendations(a.id).candidates) == len(svc.recommendations(b.id).candidates) == 1
    assert asyncio.run(svc.read_recommendations(b.id)).added_ids == []
    svc.delete_recommendation(first.id)
    assert not svc.recommendations(a.id).candidates
    assert svc.recommendations(b.id).candidates[0].id == second.id
    assert len(svc.recycle_bin(a.id).candidates) == 1
    assert svc.recycle_bin(b.id).candidates == []
    adapter.body = batch('岗位 A')
    assert asyncio.run(svc.read_recommendations(a.id)).added_ids == []
    svc.allow_recommendation_again(svc.recycle_bin(a.id).candidates[0].id)
    assert len(asyncio.run(svc.read_recommendations(a.id)).added_ids) == 1
    assert svc.recommendations(b.id).candidates[0].id == second.id


def test_legacy_global_exclusion_still_applies_to_new_jobs():
    db = database(); adapter = Adapter(batch('岗位 A')); svc = DiscoveryService(db, adapter)
    p = RecommendedPerson.model_validate(adapter.body['candidates'][0])
    db.add(RecommendationRecycleRecord(identity_key=svc.identity(p), name=p.name, base_info=p.baseInfo)); db.commit()
    for label in ['岗位 A', '岗位 B']:
        job = svc.remember_job(label, available=True); adapter.body = batch(label)
        assert asyncio.run(svc.read_recommendations(job.id)).added_ids == []
        assert svc.recycle_bin(job.id).candidates[0].scope_label == '历史全局排除'


def test_job_catalog_is_explicit_and_cached_with_no_candidate_scrape():
    db = database(); adapter = Adapter({'version': 1, 'current_job': '财务 _ 北京', 'jobs': ['财务 _ 北京', '财务 _ 上海'], 'captured_at': '2026-10-26T03:00:00Z'}); svc = DiscoveryService(db, adapter)
    assert svc.jobs()['jobs'] == [] and adapter.calls == []
    result = asyncio.run(svc.read_jobs())
    assert len(result['jobs']) == 2
    assert adapter.calls == [('recommend-jobs',)]
    assert svc.jobs() == {'jobs': result['jobs']} and len(adapter.calls) == 1
    adapter.body['jobs'] = ['财务 _ 北京', '财务 _ 北京']
    with pytest.raises(BossCliOutputError): asyncio.run(svc.read_jobs())
    assert len(svc.jobs()['jobs']) == 2
    adapter.body['jobs'] = ['财务 _ 北京']
    asyncio.run(svc.read_jobs())
    historical = next(j for j in svc.jobs()['jobs'] if j['label'] == '财务 _ 上海')
    assert not historical['available']
    calls = len(adapter.calls)
    with pytest.raises(ValueError): asyncio.run(svc.read_recommendations(historical['id']))
    assert len(adapter.calls) == calls


def test_screenshot_must_match_record_job(tmp_path, monkeypatch):
    from app.services import discovery
    monkeypatch.setattr(discovery, 'get_settings', lambda: Settings(data_dir=str(tmp_path)))
    db = database(); svc = DiscoveryService(db, Adapter(batch('岗位 A')))
    job = svc.remember_job('岗位 A', available=True)
    person = asyncio.run(svc.read_recommendations(job.id)).candidates[0]
    adapter = ScreenshotAdapter({'version': 1, 'geek_id': person.geekId, 'name': person.name, 'job_label': '岗位 B', 'captured_at': '2026-10-26T03:00:00Z'})
    svc.adapter = adapter
    with pytest.raises(BossCliOutputError, match='岗位与来源岗位不一致'): asyncio.run(svc.capture_resume(person.geekId, person.id))
    assert adapter.calls[0][-2:] == ('--job-label', '岗位 A')
    assert svc.recommendations(job.id).candidates[0].online_resume is None
    assert not list(tmp_path.rglob('*.png'))

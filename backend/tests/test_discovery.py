import asyncio
import json
import base64
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.adapters.boss_cli import BossCliResult
from app.core.json_utils import dumps, loads
from app.db.base import Base
from app.db.models import CandidateRecord, JobRecord, JobCandidateRecord, RecommendationSnapshotRecord, RecommendedCandidateRecord, RecommendedResumeRecord, RecommendationRecycleRecord, now_utc
from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.discovery import ClassifyRequest
from app.services.discovery import DiscoveryService
from app.services.local_store import LocalStoreService
from app.core.config import Settings


def database():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    return Session(engine)


class Adapter:
    def __init__(self, body):
        self.body = body
        self.calls = []

    async def run(self, *args):
        self.calls.append(args)
        return BossCliResult(args, json.dumps(self.body), '', 0)


def recommendation(count):
    person = dict(geekId='g1', name='测试候选人', salary='', baseInfo='', expect='', experience='', advantage='', highlights=[], canGreet=True, hasHistoryChat=False, hasViewed=False)
    return dict(version=1, job_label='测试岗位', limit=10, candidates=[{**person, 'geekId': f'g{i+1}', 'baseInfo': f'本科 / {i+20}岁'} for i in range(count)], captured_at='2026-10-21T08:00:00Z')


def test_recommendations_are_manual_bounded_and_separate():
    db = database()
    adapter = Adapter(recommendation(10))
    service = DiscoveryService(db, adapter)
    assert service.recommendations().captured_at is None
    assert adapter.calls == []
    assert len(asyncio.run(service.read_recommendations()).candidates) == 10
    assert adapter.calls[0][:5] == ('recommend', '--limit', '10', '--json', '--exclude-file')
    assert db.scalars(select(CandidateRecord)).all() == []
    assert len(service.recommendations().candidates) == 10
    assert len(adapter.calls) == 1  # opening cache doesn't scrape again
    adapter.body = recommendation(2)
    asyncio.run(service.read_recommendations())
    assert len(db.scalars(select(RecommendationSnapshotRecord)).all()) == 2
    assert len(service.recommendations().candidates) == 10


def test_oversized_or_invalid_output_preserves_previous_cache():
    db = database()
    adapter = Adapter(recommendation(2))
    service = DiscoveryService(db, adapter)
    asyncio.run(service.read_recommendations())
    adapter.body = recommendation(11)
    with pytest.raises(BossCliOutputError):
        asyncio.run(service.read_recommendations())
    assert len(service.recommendations().candidates) == 2


def test_classification_bounds_and_duplicate_ids_before_cli():
    adapter = Adapter({})
    service = DiscoveryService(database(), adapter)
    for ids in [[], ['same', 'same'], [str(i) for i in range(11)]]:
        with pytest.raises(ValueError):
            asyncio.run(service.classify(ids))
    with pytest.raises(ValidationError):
        ClassifyRequest(candidate_ids=[str(i) for i in range(11)])
    assert adapter.calls == []


def test_verified_state_persists_and_new_message_requires_recheck():
    db = database()
    job = JobRecord(remote_id='j1', title='测试岗位')
    candidate = CandidateRecord(remote_id='c1', name='测试姓名', stage='interviewing', profile_json=dumps({'keep': 'local-profile'}), source_snapshot=dumps({'job': job.title}))
    db.add_all([job, candidate]); db.flush()
    relation = JobCandidateRecord(job_id=job.id, candidate_id=candidate.id, last_message='你好', remote_time='刚刚')
    db.add(relation); db.commit()
    evidence = dict(recruiter_sent=False, candidate_sent=True, request_resume_enabled=False, mutual_reply_required=True, attachment_present=False)
    adapter = Adapter(dict(version=1, results=[dict(id=candidate.id, status='incoming', evidence=evidence, message='你好', time='刚刚', checked_at='2026-10-21T08:00:00Z', error='')]))
    service = DiscoveryService(db, adapter)
    result = asyncio.run(service.classify([candidate.id]))
    assert result.candidates[0].communication_status == 'incoming'
    assert candidate.stage == 'interviewing'
    assert loads(candidate.profile_json, {})['keep'] == 'local-profile'
    relation.remote_time = '昨天'; db.commit()
    assert LocalStoreService(db).detail(candidate.id).communication_status == 'unknown'
    relation.last_message = '新回复'; db.commit()
    changed = LocalStoreService(db).detail(candidate.id)
    assert changed.communication_status == 'unknown' and changed.communication_stale
    assert changed.communication_checked_at is not None


def test_wrong_candidate_result_cannot_overwrite_profile():
    db = database()
    candidate = CandidateRecord(remote_id='c1', name='测试', source_snapshot=dumps({'job': '测试岗位'}))
    db.add(candidate); db.commit()
    adapter = Adapter(dict(version=1, results=[dict(id='different-person', status='unknown', checked_at='2026-10-21T08:00:00Z')]))
    with pytest.raises(BossCliOutputError):
        asyncio.run(DiscoveryService(db, adapter).classify([candidate.id]))
    assert loads(candidate.profile_json, {}) == {}


class ScreenshotAdapter(Adapter):
    async def run(self, *args):
        self.calls.append(args)
        path = Path(args[args.index('--output') + 1])
        path.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCqkAAAAASUVORK5CYII='))
        return BossCliResult(args, json.dumps(self.body), '', 0)


def screenshot_service(tmp_path, monkeypatch):
    from app.services import discovery
    monkeypatch.setattr(discovery, 'get_settings', lambda: Settings(data_dir=str(tmp_path)))
    db = database()
    db.add(RecommendationSnapshotRecord(id='latest', snapshot_json=json.dumps(recommendation(1))))
    db.commit()
    adapter = ScreenshotAdapter(dict(version=1, geek_id='g1', name='测试候选人', captured_at='2026-10-21T09:00:00Z'))
    return DiscoveryService(db, adapter), adapter


def test_screenshot_is_bound_to_id_cached_and_retained_on_list_refresh(tmp_path, monkeypatch):
    service, adapter = screenshot_service(tmp_path, monkeypatch)
    assert service.recommendations().candidates[0].online_resume is None
    saved = asyncio.run(service.capture_resume('g1'))
    assert adapter.calls[0][:5] == ('recommend-resume', '--geek-id', 'g1', '--name', '测试候选人')
    assert service.resume_image(saved.id).is_file()
    assert service.recommendations().candidates[0].online_resume.id == saved.id
    assert len(adapter.calls) == 1  # GET image and GET cache never run CLI
    service.adapter = Adapter(recommendation(1))
    refreshed = asyncio.run(service.read_recommendations())
    assert refreshed.candidates[0].online_resume.id == saved.id
    # A similarly named person with another stable ID cannot inherit a screenshot.
    other = recommendation(1)
    other['candidates'][0]['geekId'] = 'g2'
    other['candidates'][0]['baseInfo'] = '硕士 / 25岁'
    service.adapter = Adapter(other)
    assert next(p for p in asyncio.run(service.read_recommendations()).candidates if p.geekId == 'g2').online_resume is None


def test_wrong_person_screenshot_is_removed_and_previous_image_kept(tmp_path, monkeypatch):
    service, adapter = screenshot_service(tmp_path, monkeypatch)
    saved = asyncio.run(service.capture_resume('g1'))
    adapter.body['geek_id'] = 'another-person'
    with pytest.raises(BossCliOutputError):
        asyncio.run(service.capture_resume('g1'))
    assert service.recommendations().candidates[0].online_resume.id == saved.id
    assert len(list((tmp_path / 'recommended-resumes').glob('*.png'))) == 1


def test_unknown_id_and_arbitrary_file_cannot_be_read(tmp_path, monkeypatch):
    service, adapter = screenshot_service(tmp_path, monkeypatch)
    with pytest.raises(LookupError):
        asyncio.run(service.capture_resume('not-in-snapshot'))
    with pytest.raises(LookupError):
        service.resume_image('../.env')
    with pytest.raises(LookupError):
        service.resume_image('0' * 32)
    assert adapter.calls == []


def test_old_duplicate_snapshot_is_normalized_without_remote_read(tmp_path, monkeypatch):
    service, adapter = screenshot_service(tmp_path, monkeypatch)
    old = recommendation(1)
    old['candidates'] *= 2
    service.db.get(RecommendationSnapshotRecord, 'latest').snapshot_json = json.dumps(old)
    service.db.commit()
    assert len(service.recommendations().candidates) == 1
    assert adapter.calls == []
    assert asyncio.run(service.capture_resume('g1')).id


def test_library_accumulates_and_matches_both_name_and_basic_info():
    db = database()
    adapter = Adapter(recommendation(10))
    svc = DiscoveryService(db, adapter)
    first = asyncio.run(svc.read_recommendations())
    assert len(first.added_ids) == 10
    second_body = recommendation(10)
    for i, p in enumerate(second_body['candidates']):
        p['baseInfo'] = f'硕士 / {i+20}岁'
        p['geekId'] = f'new-{i}'
    adapter.body = second_body
    second = asyncio.run(svc.read_recommendations())
    assert len(second.candidates) == 20  # same name, different basic info: retain both
    assert len(second.added_ids) == 10
    for p in second_body['candidates']:
        p['geekId'] += '-changed'
        p['name'] = '  ' + p['name'] + '  '
    duplicate = asyncio.run(svc.read_recommendations())
    assert len(duplicate.candidates) == 20 and duplicate.added_ids == []
    # Same basic info, different name must also remain distinct.
    adapter.body = recommendation(1)
    adapter.body['candidates'][0]['name'] = '另一个姓名'
    assert len(asyncio.run(svc.read_recommendations()).candidates) == 21
    assert len(DiscoveryService(db, adapter).recommendations().candidates) == 21


def test_delete_is_local_keeps_other_people_and_prevents_reimport(tmp_path, monkeypatch):
    service, adapter = screenshot_service(tmp_path, monkeypatch)
    saved = asyncio.run(service.capture_resume('g1'))
    person = service.recommendations().candidates[0]
    calls = len(adapter.calls)
    service.delete_recommendation(person.id)
    assert service.recommendations().candidates == []
    with pytest.raises(LookupError):
        service.resume_image(saved.id)
    assert not service._screenshot_path(saved.id).exists()
    assert service.db.scalars(select(RecommendedCandidateRecord)).all() == []
    bin_entry = service.recycle_bin().candidates[0]
    assert bin_entry.name == person.name and bin_entry.baseInfo == person.baseInfo
    assert set(bin_entry.model_dump()) == {'id', 'name', 'baseInfo'}
    assert len(adapter.calls) == calls
    with pytest.raises(LookupError):
        asyncio.run(service.capture_resume('g1', person.id))
    service.adapter = Adapter(recommendation(1))
    assert asyncio.run(service.read_recommendations()).added_ids == []
    assert DiscoveryService(service.db, adapter).recommendations().candidates == []
    with pytest.raises(LookupError):
        service.delete_recommendation('missing')


def test_exclusion_file_contains_both_identity_fields():
    class ExclusionAdapter(Adapter):
        async def run(self, *args):
            excluded = json.loads(Path(args[args.index('--exclude-file') + 1]).read_text(encoding='utf-8'))
            assert excluded == [{'name': '测试候选人', 'baseInfo': '本科 / 20岁'}]
            return await super().run(*args)
    db = database()
    db.add(RecommendationSnapshotRecord(id='latest', snapshot_json=json.dumps(recommendation(1))))
    db.commit()
    svc = DiscoveryService(db, ExclusionAdapter(recommendation(0)))
    assert len(asyncio.run(svc.read_recommendations()).candidates) == 1


def test_recycle_bin_excludes_pair_but_allows_same_name_with_different_info(tmp_path, monkeypatch):
    svc, adapter = screenshot_service(tmp_path, monkeypatch)
    person = svc.recommendations().candidates[0]
    svc.delete_recommendation(person.id)

    class CheckRecycleAdapter(Adapter):
        async def run(self, *args):
            excluded = json.loads(Path(args[args.index('--exclude-file') + 1]).read_text(encoding='utf-8'))
            assert excluded == [{'name': person.name, 'baseInfo': person.baseInfo}]
            return await super().run(*args)
    incoming = recommendation(2)
    # First is the recycled identity, even if BOSS changes its remote ID.
    incoming['candidates'][0]['geekId'] = 'changed-id'
    svc.adapter = CheckRecycleAdapter(incoming)
    result = asyncio.run(svc.read_recommendations())
    assert len(result.added_ids) == 1
    assert result.candidates[0].name == person.name
    assert result.candidates[0].baseInfo != person.baseInfo
    assert len(DiscoveryService(svc.db, adapter).recycle_bin().candidates) == 1
    assert adapter.calls == []  # opening/deleting/recycle reads don't access BOSS


def test_previous_soft_deletions_migrate_to_minimal_recycle_records(tmp_path, monkeypatch):
    svc, adapter = screenshot_service(tmp_path, monkeypatch)
    first = asyncio.run(svc.capture_resume('g1'))
    second = asyncio.run(svc.capture_resume('g1'))
    person = svc.recommendations().candidates[0]
    row = svc.db.get(RecommendedCandidateRecord, person.id)
    row.deleted_at = now_utc()
    svc.db.commit()
    migrated = svc.recycle_bin()
    assert len(migrated.candidates) == 1
    assert migrated.candidates[0].name == person.name
    assert svc.db.scalars(select(RecommendedCandidateRecord)).all() == []
    assert svc.db.scalars(select(RecommendedResumeRecord)).all() == []
    assert not svc._screenshot_path(first.id).exists()
    assert not svc._screenshot_path(second.id).exists()
    cached = json.loads(svc.db.get(RecommendationSnapshotRecord, 'latest').snapshot_json)
    assert cached['candidates'] == []
    assert len(svc.recycle_bin().candidates) == 1  # migration is idempotent
    assert len(adapter.calls) == 2


def test_deletion_preserves_other_candidates_screenshots(tmp_path, monkeypatch):
    svc, adapter = screenshot_service(tmp_path, monkeypatch)
    original = svc.recommendations().candidates[0]
    old_image = asyncio.run(svc.capture_resume('g1'))
    other = recommendation(1)
    other['candidates'][0].update(geekId='g2', baseInfo='硕士 / 30岁')
    svc.adapter = Adapter(other)
    new_person = next(p for p in asyncio.run(svc.read_recommendations()).candidates if p.geekId == 'g2')
    adapter.body['geek_id'] = 'g2'
    svc.adapter = adapter
    other_image = asyncio.run(svc.capture_resume('g2', new_person.id))
    svc.delete_recommendation(original.id)
    assert svc.resume_image(other_image.id).exists()
    assert not svc._screenshot_path(old_image.id).exists()
    assert len(svc.recommendations().candidates) == 1


def test_allow_again_only_releases_selected_pair_and_waits_for_manual_read():
    db = database()
    adapter = Adapter(recommendation(2))
    svc = DiscoveryService(db, adapter)
    people = asyncio.run(svc.read_recommendations()).candidates
    for person in people:
        svc.delete_recommendation(person.id)
    recycled = svc.recycle_bin().candidates
    assert len(recycled) == 2 and recycled[0].name == recycled[1].name
    target, other = recycled
    calls_before = len(adapter.calls)
    svc.allow_recommendation_again(target.id)
    assert len(adapter.calls) == calls_before  # no BOSS access on restore
    assert svc.recommendations().candidates == []  # no placeholder profile
    restarted = DiscoveryService(db, adapter)
    assert [p.id for p in restarted.recycle_bin().candidates] == [other.id]

    class CheckRemainingExclusions(Adapter):
        async def run(self, *args):
            excluded = json.loads(Path(args[args.index('--exclude-file') + 1]).read_text(encoding='utf-8'))
            assert excluded == [{'name': other.name, 'baseInfo': other.baseInfo}]
            return await super().run(*args)
    restarted.adapter = CheckRemainingExclusions(recommendation(2))
    result = asyncio.run(restarted.read_recommendations())
    assert len(result.added_ids) == 1
    assert result.candidates[0].baseInfo == target.baseInfo
    assert result.candidates[0].online_resume is None
    assert [p.id for p in restarted.recycle_bin().candidates] == [other.id]


def test_allow_again_unknown_entry_leaves_recycle_bin_unchanged():
    adapter = Adapter(recommendation(1))
    svc = DiscoveryService(database(), adapter)
    person = asyncio.run(svc.read_recommendations()).candidates[0]
    svc.delete_recommendation(person.id)
    before = svc.recycle_bin().model_dump()
    calls_before = len(adapter.calls)
    with pytest.raises(LookupError):
        svc.allow_recommendation_again('missing')
    assert svc.recycle_bin().model_dump() == before
    assert len(adapter.calls) == calls_before

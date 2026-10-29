import asyncio
import json
import os
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes.ai import router
from app.core.ai_secrets import protect, reveal
from app.core.config import Settings
from app.core.json_utils import dumps, loads
from app.db.base import Base
from app.db.models import (AIConnectionRecord, AIJobPromptRecord, AIManagedRunRecord, CandidateRecord, CommunicationRecycleRecord,
    JobCandidateRecord, JobRecord, RecommendedCandidateRecord, RecommendationHiddenRecord, RecommendationJobRecord,
    RecommendedResumeRecord, TableCellRecord, TableWorkspaceRecord)
from app.db.session import get_db
from app.schemas.ai import AIConfig, AIConfigSave, AISelection
from app.services import ai_management as ai
from app.services.discovery import DiscoveryService


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, autoflush=False)
    monkeypatch.setattr(ai, 'get_settings', lambda: Settings(data_dir=str(tmp_path)))
    with factory() as db:
        yield db, factory, tmp_path
    engine.dispose()


def people(db):
    rows = [RecommendedCandidateRecord(id=f'person-{i}', identity_key=f'identity-{i}', source_job='技术岗位' if i != 2 else '其他岗位',
        person_json=dumps({'name': '同名人选', 'baseInfo': f'基本信息 {i}', 'advantage': 'Python 项目', 'geekId': 'never-send-this-token'})) for i in range(4)]
    rows[3].deleted_at = datetime.now(timezone.utc)
    db.add_all(rows)
    db.commit()
    return rows


def selection(ids=None, **kwargs):
    return AISelection(source='recommendations', candidate_ids=ids or ['person-0'], **kwargs)


def configured(db):
    svc = ai.AIManagementService(db)
    svc.save_config(AIConfigSave(base_url='http://localhost:1234/v1', model='mock-model', prompt='按我的要求，用证据分析'))
    return svc


def test_recommendation_result_uses_latest_success_and_strict_first_line(store):
    db, _, _ = store
    people(db)
    old = AIManagedRunRecord(id='old', status='success', config_json=dumps({'model': 'old-model'}),
        selection_json=dumps({'source': 'recommendations'}), items_json=dumps([
            {'candidate_id': 'person-0', 'status': 'success', 'output': '★★★★★\n旧结果'}]))
    recent = AIManagedRunRecord(id='recent', status='success', config_json=dumps({'model': 'new-model'}),
        selection_json=dumps({'source': 'recommendations'}), items_json=dumps([
            {'candidate_id': 'person-0', 'status': 'success', 'output': '★★★★\n新结果'},
            {'candidate_id': 'person-1', 'status': 'success', 'output': '推荐：★★★★★\n格式错误'},
            {'candidate_id': 'person-2', 'status': 'success', 'output': '★★★\n其他岗位'},
            {'candidate_id': 'person-3', 'status': 'success', 'output': '★★\n已删除'}]))
    old.created_at = datetime(2026, 10, 27, tzinfo=timezone.utc)
    recent.created_at = datetime(2026, 10, 29, tzinfo=timezone.utc)
    db.add_all([old, recent, RecommendationHiddenRecord(candidate_id='person-1')])
    db.commit()
    results = ai.AIManagementService(db).recommendation_results(DiscoveryService.job_key('技术岗位'))
    assert [(r['candidate_id'], r['stars'], r['output']) for r in results] == [('person-0', 4, '★★★★\n新结果')]
    assert ai.AIManagementService.stars_from_output('推荐：★★★★★') == 0
    assert ai.AIManagementService.stars_from_output('⭐️⭐️⭐️\n详情') == 3
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        summary = client.get('/api/ai/recommendation-results', params={'job_id': DiscoveryService.job_key('技术岗位')})
        assert summary.status_code == 200
        assert summary.json()[0]['stars'] == 4
        assert 'output' not in summary.json()[0]
        detail = client.get('/api/ai/recommendation-results/person-0', params={'job_id': DiscoveryService.job_key('技术岗位')})
        assert detail.json()['output'] == '★★★★\n新结果'
        assert client.get('/api/ai/recommendation-results/person-2', params={'job_id': DiscoveryService.job_key('技术岗位')}).status_code == 404


def test_job_prompts_are_separate_and_frozen_into_each_recommendation_run(store):
    db, _, _ = store
    people(db)
    first = DiscoveryService.job_key('技术岗位')
    second = DiscoveryService.job_key('其他岗位')
    db.add_all([RecommendationJobRecord(id=first, label='技术岗位'), RecommendationJobRecord(id=second, label='其他岗位')])
    db.commit()
    svc = configured(db)
    assert not svc.job_prompt(first)['custom']
    assert svc.job_prompt(first)['prompt'] == ''
    svc.save_job_prompt(first, '只分析技术岗位', '技术岗位 JD')
    assert svc.job_prompt(first)['custom']
    assert svc.job_prompt(first)['jd'] == '技术岗位 JD'
    db.get(RecommendationJobRecord, first).available = False
    db.commit()
    assert svc.job_prompt(first)['prompt'] == '只分析技术岗位'
    assert svc.job_prompt(first)['jd'] == '技术岗位 JD'
    db.get(RecommendationJobRecord, first).available = True
    db.commit()
    assert svc.job_prompt(second)['prompt'] == ''
    assert svc.config()[0].prompt == '按我的要求，用证据分析'
    run, config, _ = svc.create_run(selection(job_id=first))
    assert config.prompt == '通用提示词：\n按我的要求，用证据分析\n\n岗位 JD：\n技术岗位 JD\n\n岗位打分标准：\n只分析技术岗位'
    assert loads(run.config_json, {})['prompt'] == config.prompt
    svc.save_job_prompt(first, '新版本技术岗位提示词')
    assert loads(db.get(AIManagedRunRecord, run.id).config_json, {})['prompt'] == config.prompt
    run.status = 'success'
    db.commit()
    _, other_config, _ = svc.create_run(selection(ids=['person-2'], job_id=second))
    assert other_config.prompt == '通用提示词：\n按我的要求，用证据分析'
    assert svc.clear_job_prompt(first)['prompt'] == ''
    assert svc.job_prompt(first)['jd'] == '技术岗位 JD'
    assert db.get(AIJobPromptRecord, first) is None


def test_job_prompt_api_persists_and_rejects_unknown_job(store):
    db, _, _ = store
    key = DiscoveryService.job_key('运营岗位')
    db.add(RecommendationJobRecord(id=key, label='运营岗位'))
    db.commit()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        assert client.get(f'/api/ai/prompts/{key}').json()['custom'] is False
        saved = client.put(f'/api/ai/prompts/{key}', json={'prompt': '  运营岗位专属要求  '})
        assert saved.status_code == 200
        assert saved.json()['prompt'] == '运营岗位专属要求'
        assert client.put(f'/api/ai/prompts/{key}', json={'jd': '岗位要求'}).json()['jd'] == '岗位要求'
        assert client.get(f'/api/ai/prompts/{key}').json()['custom'] is True
        assert client.put(f'/api/ai/prompts/{key}', json={'prompt': '   '}).status_code == 422
        assert client.get('/api/ai/prompts/missing').status_code == 404
        assert client.delete(f'/api/ai/prompts/{key}').json()['custom'] is False


@pytest.mark.skipif(os.name != 'nt', reason='Windows DPAPI')
def test_credentials_are_encrypted_retained_cleared_and_bound_to_endpoint(store):
    db, _, _ = store
    svc = ai.AIManagementService(db)
    secret = 'test-key-for-local-unit-test-only'
    public = svc.save_config(AIConfigSave(model='test', api_key=secret))
    row = db.get(AIConnectionRecord, 'default')
    assert secret not in row.encrypted_key and secret not in row.config_json
    assert public['has_key'] and secret not in dumps(public)
    assert reveal(row.encrypted_key) == secret
    assert secret not in repr(AIConfigSave(api_key=secret))
    svc.save_config(AIConfigSave(model='changed'))
    assert svc.ready_config()[1] == secret
    with pytest.raises(ValueError, match='地址已更换'):
        svc.save_config(AIConfigSave(base_url='https://example.org/v1'))
    svc.save_config(AIConfigSave(base_url='https://example.org/v1', clear_key=True))
    assert not svc.public_config()['has_key']
    assert reveal(protect(secret)) == secret


@pytest.mark.parametrize('url', ['http://example.org', 'https://key:secret@example.org', 'https://example.org?key=secret', 'file:///etc/passwd'])
def test_bad_endpoint_rejected(url):
    with pytest.raises(ValidationError):
        AIConfig(base_url=url)


@pytest.mark.parametrize(('url', 'expected'), [
    ('https://models.example/', 'https://models.example/v1'),
    (' https://models.example/v1/ ', 'https://models.example/v1'),
    ('https://models.example/v1/models', 'https://models.example/v1'),
    ('https://models.example/v1/chat/completions', 'https://models.example/v1'),
    ('https://models.example/proxy/openai/v2/', 'https://models.example/proxy/openai/v2'),
    ('http://localhost:1234', 'http://localhost:1234/v1'),
])
def test_model_endpoint_normalizes_base_url(url, expected):
    assert AIConfig(base_url=url).base_url == expected


def test_model_list_reads_ids_without_inference_and_without_a_selected_model(store, monkeypatch):
    db, _, _ = store
    secret = 'model-list-test-key'
    svc = ai.AIManagementService(db)
    svc.save_config(AIConfigSave(base_url='http://localhost:1234', api_key=secret))
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'data': [
            {'id': 'z-vision', 'owned_by': 'private-metadata'}, {'id': 'a-text'}, {'id': 'z-vision'}]})

    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        result = client.post('/api/ai/models')
        assert result.status_code == 200
        assert result.json() == {'models': [{'id': 'a-text'}, {'id': 'z-vision'}], 'endpoint': 'http://localhost:1234/v1/models'}
        assert secret not in result.text
        assert client.post('/api/ai/models', headers={'origin': 'https://untrusted.example'}).status_code == 403
    assert len(requests) == 1
    assert requests[0].method == 'GET' and requests[0].content == b''
    assert str(requests[0].url) == 'http://localhost:1234/v1/models'
    assert requests[0].headers['Authorization'] == f'Bearer {secret}'
    assert svc.public_config()['model'] == ''
    assert db.scalar(select(AIManagedRunRecord)) is None


@pytest.mark.parametrize('code', [401, 403, 404, 405, 429, 302, 500, 501])
def test_model_list_errors_are_clear_and_never_follow_redirects(monkeypatch, code):
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(code, text='PRIVATE KEY', headers={'Location': 'https://untrusted.example'})

    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(ai.AIRequestError) as exc:
        asyncio.run(ai.fetch_models(AIConfig(), 'private-key'))
    assert len(requests) == 1 and 'private' not in str(exc.value).lower()
    assert '模型列表' in str(exc.value) or 'API Key' in str(exc.value)


@pytest.mark.parametrize('body', ['<html>PRIVATE</html>', '{}', '{"data":{}}', '{"data":[{}]}', '{"data":[{"id":123}]}', '{"data":[{"id":" "}]}'])
def test_model_list_rejects_invalid_response(monkeypatch, body):
    original = httpx.AsyncClient
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)), **kwargs))
    with pytest.raises(ai.AIRequestError) as exc:
        asyncio.run(ai.fetch_models(AIConfig(), 'private-key'))
    assert 'PRIVATE' not in str(exc.value) and '手动' in str(exc.value)


def test_model_list_empty_local_catalog_and_network_timeout(monkeypatch):
    original = httpx.AsyncClient
    def empty(request):
        assert 'Authorization' not in request.headers
        return httpx.Response(200, json={'data': []})
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(empty), **kwargs))
    assert asyncio.run(ai.fetch_models(AIConfig(base_url='http://localhost:1234'), ''))['models'] == []
    def timeout(request):
        raise httpx.ReadTimeout('sensitive upstream diagnostic', request=request)
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(timeout), **kwargs))
    with pytest.raises(ai.AIRequestError, match='获取模型列表超时'):
        asyncio.run(ai.fetch_models(AIConfig(), 'key'))


def test_snapshot_uses_stable_ids_job_scope_custom_fields_and_no_deleted_records(store):
    db, _, _ = store
    people(db)
    db.add(TableWorkspaceRecord(scope='recommendations', config_json=dumps({'fields': [{'id': 'custom_skill', 'name': '项目备注'}]})))
    db.add(TableCellRecord(scope='recommendations', record_id='person-1', field_id='custom_skill', value_json='"需要确认 Python 经历"'))
    db.commit()
    svc = configured(db)
    job_id = DiscoveryService.job_key('技术岗位')
    assert len(svc.catalog('recommendations', job_id)['candidates']) == 2
    snapshot = svc.snapshot(selection(['person-0', 'person-1'], job_id=job_id))
    assert len(snapshot) == 2 and snapshot[0]['data']['baseInfo'] != snapshot[1]['data']['baseInfo']
    assert snapshot[1]['data']['local_fields'][0]['field'] == '项目备注'
    assert 'never-send-this-token' not in dumps(snapshot)
    for ids in [['person-3'], ['missing']]:
        with pytest.raises(ValueError, match='删除'):
            svc.snapshot(selection(ids))
    with pytest.raises(ValueError, match='不属于'):
        svc.snapshot(selection(['person-2'], job_id=job_id))
    with pytest.raises(ValidationError):
        selection(['person-0', 'person-0'])
    with pytest.raises(ValidationError):
        selection([str(i) for i in range(21)])


def test_communication_data_is_local_and_respects_recycle_and_job(store):
    db, _, _ = store
    db.add_all([CandidateRecord(id='c', remote_id='remote', name='测试候选人'), JobRecord(id='j', remote_id='job', title='后端岗位')])
    db.flush()
    db.add(JobCandidateRecord(candidate_id='c', job_id='j', last_message='我做过 Python 项目', remote_job_text='后端岗位'))
    db.commit()
    svc = configured(db)
    data = svc.snapshot(AISelection(source='communications', job_id='j', candidate_ids=['c']))
    assert data[0]['data']['local_conversations'][0]['last_message'] == '我做过 Python 项目'
    db.add(CommunicationRecycleRecord(remote_id='remote', name='测试候选人'))
    db.commit()
    assert svc.catalog('communications')['candidates'] == []


def test_real_http_shape_contains_prompt_text_image_and_does_not_follow_redirects(monkeypatch):
    original = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': '分析结果'}, 'finish_reason': 'length'}], 'usage': {'total_tokens': 42, 'not_allowed': 'private'}})
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    config = AIConfig(model='mock', prompt='用户要求', max_tokens=2048, temperature=None)
    result = asyncio.run(ai.call_model(config, 'fake-key', config.prompt, {'skill': 'Python'}, b'fake-image'))
    request = requests[0]
    body = json.loads(request.content)
    assert str(request.url) == 'https://api.openai.com/v1/chat/completions'
    assert request.headers['Authorization'] == 'Bearer fake-key'
    assert '用户要求' in body['messages'][0]['content']
    assert 'Python' in body['messages'][1]['content'][0]['text']
    assert body['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/png;base64,')
    assert body['max_completion_tokens'] == 2048 and 'temperature' not in body
    assert result['usage'] == {'total_tokens': 42} and result['truncated']
    assert 'tools' not in body


@pytest.mark.parametrize('enabled', [False, True])
def test_session_header_is_opt_in_opaque_and_independent_per_candidate(monkeypatch, enabled):
    original = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}]})
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    config = AIConfig(model='mock', send_session_id=enabled)
    for name in ['candidate-one', 'candidate-two']:
        asyncio.run(ai.call_model(config, 'private-key', 'test', {'name': name}))
    assert len(requests) == 2
    assert all(request.headers['User-Agent'].startswith('AI-HR/') for request in requests)
    if enabled:
        ids = [request.headers['x-opencode-session'] for request in requests]
        assert len(set(ids)) == 2
        assert all(value.startswith('ai-hr-') and len(value) == 38 for value in ids)
        assert all('candidate' not in value and 'private' not in value for value in ids)
    else:
        assert all('x-opencode-session' not in request.headers for request in requests)


@pytest.mark.parametrize('nested', [False, True])
def test_missing_session_id_has_specific_safe_error_and_no_automatic_retry(monkeypatch, nested):
    original = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(request)
        error = {'type': 'MissingSessionID', 'message': 'PRIVATE KEY private-key'}
        return httpx.Response(400, json={'error': error} if nested else error)
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(ai.AIRequestError, match='MissingSessionID') as exc:
        asyncio.run(ai.call_model(AIConfig(model='mock'), 'private-key', 'test'))
    assert exc.value.fatal and len(requests) == 1
    assert '发送会话标识' in str(exc.value) and 'private' not in str(exc.value).lower()


def test_session_header_option_round_trips_in_config(store):
    db, _, _ = store
    svc = ai.AIManagementService(db)
    assert svc.public_config()['send_session_id'] is False
    svc.save_config(AIConfigSave(send_session_id=True))
    assert svc.config()[0].send_session_id is True


@pytest.mark.parametrize('code', [401, 429, 302, 500])
def test_upstream_errors_do_not_expose_response_or_keys(monkeypatch, code):
    original = httpx.AsyncClient
    def handler(request):
        return httpx.Response(code, json={'error': 'PRIVATE KEY and CANDIDATE CONTENT'}, headers={'Location': 'https://example.org/stolen'})
    monkeypatch.setattr(ai.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(ai.AIRequestError) as exc:
        asyncio.run(ai.call_model(AIConfig(model='mock'), 'private-key', 'test'))
    assert 'PRIVATE' not in str(exc.value) and 'private-key' not in str(exc.value)


def test_background_analysis_freezes_prompt_progress_results_and_does_not_change_candidates(store, monkeypatch):
    db, factory, _ = store
    people(db)
    svc = configured(db)
    row, config, key = svc.create_run(selection(['person-0', 'person-1']))
    calls = []
    async def fake(config, key, prompt, data, image):
        calls.append((prompt, data))
        if len(calls) == 2:
            raise ai.AIRequestError('超时')
        return {'output': '有项目证据', 'usage': {'total_tokens': 10}, 'elapsed_seconds': 0.1}
    monkeypatch.setattr(ai, 'call_model', fake)
    svc.save_config(AIConfigSave(base_url='http://localhost:1234/v1', model='new-model', prompt='新提示词'))
    with pytest.raises(ValueError, match='已有'):
        svc.create_run(selection())
    asyncio.run(ai.execute_run(row.id, config, key, factory))
    db.expire_all()
    saved = db.get(AIManagedRunRecord, row.id)
    result = svc.run_view(saved)
    assert result['status'] == 'partial' and result['completed'] == 2 and result['failed'] == 1
    assert calls[0][0] == '按我的要求，用证据分析' and result['config']['model'] == 'mock-model'
    assert result['items'][0]['output'] == '有项目证据'
    assert len(svc.catalog('recommendations')['candidates']) == 3


def test_fatal_failure_stops_remaining_calls_and_restart_is_not_retried(store, monkeypatch):
    db, factory, _ = store
    people(db)
    svc = configured(db)
    row, config, key = svc.create_run(selection(['person-0', 'person-1']))
    calls = []
    async def fake(*args):
        calls.append(1)
        raise ai.AIRequestError('API Key 无效', fatal=True)
    monkeypatch.setattr(ai, 'call_model', fake)
    asyncio.run(ai.execute_run(row.id, config, key, factory))
    db.expire_all()
    assert len(calls) == 1
    result = svc.run_view(db.get(AIManagedRunRecord, row.id))
    assert result['completed'] == 2 and result['status'] == 'failed'
    row2, _, _ = svc.create_run(selection())
    ai.recover_interrupted_runs(db)
    assert row2.status == 'failed' and '重启' in row2.error
    assert len(calls) == 1


def test_images_must_be_local_valid_and_selected(store):
    db, _, root = store
    rows = people(db)
    rows[0].screenshot_id = 'a' * 32
    db.add(RecommendedResumeRecord(id='a' * 32, geek_id='remote', name='测试'))
    db.commit()
    svc = configured(db)
    assert svc.snapshot(selection())[0]['image_id'] is None
    with pytest.raises(ValueError, match='缺失'):
        svc.snapshot(selection(include_images=True))
    folder = root / 'recommended-resumes'
    folder.mkdir()
    (folder / ('a' * 32 + '.png')).write_bytes(b'\x89PNG\r\n\x1a\nmock-png')
    assert svc.snapshot(selection(include_images=True))[0]['image_id'] == 'a' * 32
    with pytest.raises(ValueError):
        svc.image_bytes('../anything')


def test_api_preview_never_calls_model_and_external_origin_is_blocked(store, monkeypatch):
    db, _, _ = store
    people(db)
    configured(db)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    async def forbidden(*args):
        pytest.fail('Preview or config must not call a model')
    monkeypatch.setattr(ai, 'call_model', forbidden)
    with TestClient(app) as client:
        assert client.get('/api/ai/config').json()['has_key'] is False
        result = client.post('/api/ai/preview', json=selection().model_dump())
        assert result.status_code == 200 and len(result.json()['items']) == 1
        assert client.post('/api/ai/preview', json=selection().model_dump(), headers={'origin': 'https://untrusted.example'}).status_code == 403
        assert db.scalar(select(AIManagedRunRecord)) is None

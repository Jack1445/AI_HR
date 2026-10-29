import json
from datetime import date
from types import SimpleNamespace

import pytest

from app.parsers.boss_cli_output import BossCliOutputError
from app.schemas.recruiting import Job, JobStats
from app.services.boss_readonly import BossReadOnlyService


class CutoffAdapter:
    async def run(self, *args, **kwargs):
        return SimpleNamespace(stdout=json.dumps({
            'version': 1, 'since': '2026-10-01', 'stop_reason': 'date_cutoff',
            'scanned': 20, 'undated': 0,
            'rows': [{'sourceId': 'chat-1', 'legacyMatchUnique': True,
                      'name': '测试人选', 'job': '测试岗位', 'time': '10月20日',
                      'message': '你好', 'unreadCount': 0}],
        }))


def complete(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError('Fake CLI unexpectedly awaited external I/O')


def test_date_cutoff_snapshot_requires_matching_date_scope():
    job = Job(id='job-1', title='测试岗位', status='active', label='', meta=[],
              stats=JobStats(viewed=0, chatted=0, interested=0))
    service = BossReadOnlyService(CutoffAdapter())
    result = complete(service.list_candidates_for_jobs([job], history=True, since=date(2026, 10, 1)))
    assert [person.name for person in result[job.id].candidates] == ['测试人选']
    assert service.history_summary['stop_reason'] == 'date_cutoff'
    with pytest.raises(BossCliOutputError):
        complete(service.list_candidates_for_jobs([job], history=True))

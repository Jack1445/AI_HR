import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError

from app.api.routes.local_data import service
from app.core.json_utils import loads
from app.db.base import Base
from app.db.errors import redact_legacy_sql_error
from app.db.models import AuditEventRecord, CandidateRecord, JobCandidateRecord, JobRecord, SyncRunRecord
from app.db.session import SessionLocal
from app.main import app
from app.schemas.recruiting import Candidate, Job, JobStats
from app.services.local_store import LocalStoreService
from test_sync_persistence import SnapshotBoss


def test_failed_transaction_rolls_back_and_hides_sql_and_messages(tmp_path, caplog):
    engine = create_engine('sqlite:///' + (tmp_path / 'test.db').as_posix())
    Base.metadata.create_all(engine)
    with SessionLocal(bind=engine) as db:
        old = CandidateRecord(remote_id='old-person', name='Old person', owner='Keep owner')
        db.add(old)
        db.commit()
        jobs = [Job(id='job', title='Job', status='active', label='', meta=[], stats=JobStats(viewed=0, chatted=0, interested=0))]
        rows = [Candidate(name='New person', job='Job', source_id='new-chat', time='today', message='PRIVATE_CHAT_SENTINEL', unread_count=0)]
        svc = LocalStoreService(db, SnapshotBoss(jobs, rows))

        def fail_relation_write(session, *_):
            if any(isinstance(row, JobCandidateRecord) for row in session.new):
                raise IntegrityError('INSERT INTO job_candidates VALUES (?)', ['PRIVATE_CHAT_SENTINEL'], sqlite3.IntegrityError('UNIQUE constraint failed: job_candidates.job_id, job_candidates.candidate_id'))

        event.listen(db, 'before_flush', fail_relation_write)
        app.dependency_overrides[service] = lambda: svc
        try:
            response = TestClient(app).post('/api/local/sync')
        finally:
            app.dependency_overrides.pop(service, None)
            event.remove(db, 'before_flush', fail_relation_write)
        assert response.status_code == 500
        assert '数据关联发生冲突' in response.json()['detail']
        assert db.query(CandidateRecord).count() == 1
        assert old.owner == 'Keep owner'
        assert db.query(JobRecord).count() == db.query(JobCandidateRecord).count() == 0
        run = db.scalar(select(SyncRunRecord))
        assert run.status == 'failed'
        audit = db.scalar(select(AuditEventRecord))
        assert audit.event_type == 'sync_failed'
        diagnostic = Path(svc.diagnostic_log_path).read_text(encoding='utf-8')
        for output in (response.text, run.error_summary, audit.detail_json, diagnostic, caplog.text):
            assert 'PRIVATE_CHAT_SENTINEL' not in output
            assert 'INSERT INTO' not in output
            assert '[parameters:' not in output
        assert 'job_candidates.job_id' in diagnostic


def test_existing_diagnostic_errors_are_redacted_without_changing_saved_log(tmp_path):
    from app.api.routes.debug import _summarize_log
    original = 'IntegrityError: UNIQUE constraint failed: job_candidates.job_id\n[SQL: INSERT INTO job_candidates]\n[parameters: PRIVATE_CHAT_SENTINEL]'
    path = tmp_path / 'old-error.log'
    path.write_text(json.dumps(dict(event='sync.failed', time='2026-10-26T08:00:00+00:00', elapsed_seconds=1, details={'error': original})), encoding='utf-8')
    assert 'PRIVATE_CHAT_SENTINEL' not in json.dumps(_summarize_log(path))
    assert '[SQL:' not in redact_legacy_sql_error(original)
    assert 'PRIVATE_CHAT_SENTINEL' in path.read_text(encoding='utf-8')

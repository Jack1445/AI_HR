import json

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api.routes.tables import remove_communication
from app.core.greeting_identity import identity as greeting_identity
from app.db.base import Base
from app.db.models import (
    CandidateRecord, JobCandidateRecord, JobRecord, RecommendedCandidateRecord,
    RecommendationGreetingLedgerRecord, RecommendationHiddenRecord,
    RecommendationRecycleRecord,
)
from app.schemas.discovery import RecommendedPerson
from app.services.discovery import DiscoveryService
from app.services.local_store import LocalStoreService
from app.services.recommendation_scope import build_active_recommendation_index


JOB_LABEL = '测试岗位 _ 北京 100-200元/天'


def add_recommendation(db: Session, name: str, geek_id: str, greeted: bool) -> RecommendedCandidateRecord:
    person = RecommendedPerson(
        geekId=geek_id, name=name, salary='', baseInfo='23岁 / 本科',
        expect='', experience='', advantage='', highlights=[],
        canGreet=True, hasHistoryChat=False, hasViewed=False,
    )
    row = RecommendedCandidateRecord(
        identity_key=f'identity-{geek_id}', source_job=JOB_LABEL,
        person_json=person.model_dump_json(),
    )
    db.add(row)
    if greeted:
        db.add(RecommendationGreetingLedgerRecord(
            id=greeting_identity(DiscoveryService.job_key(JOB_LABEL), geek_id),
            batch_id='test', status='sent',
        ))
    db.commit()
    return row


def test_greeted_recommendation_hide_keeps_chat_until_communication_delete():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        recommended = add_recommendation(db, '已招呼', 'geek-1', greeted=True)
        job = JobRecord(remote_id='boss-job-1', title='测试岗位')
        chat = CandidateRecord(remote_id='boss-chat-1', name='已招呼')
        db.add_all([job, chat])
        db.flush()
        db.add(JobCandidateRecord(
            job_id=job.id, candidate_id=chat.id, remote_job_text='测试岗位',
            source_snapshot=json.dumps({'recommendation_identity': recommended.identity_key}),
        ))
        db.commit()

        svc = DiscoveryService(db, None)
        assert LocalStoreService(db).list_candidates().total == 1
        svc.delete_recommendation(recommended.id)

        assert db.get(RecommendationHiddenRecord, recommended.id) is not None
        assert db.get(RecommendedCandidateRecord, recommended.id) is not None
        assert db.get(RecommendationRecycleRecord, recommended.identity_key) is None
        assert svc.recommendations().candidates == []
        assert svc.jobs()['jobs'][0]['count'] == 0
        assert LocalStoreService(db).list_candidates().total == 1
        assert build_active_recommendation_index(db, greeted_only=True)

        remove_communication(db, chat.id)
        assert db.get(CandidateRecord, chat.id) is None
        assert db.get(RecommendedCandidateRecord, recommended.id) is None
        assert db.get(RecommendationHiddenRecord, recommended.id) is None
        assert db.get(RecommendationRecycleRecord, recommended.identity_key) is not None
        assert LocalStoreService(db).list_candidates().total == 0
    engine.dispose()


def test_ungreeted_recommendation_delete_keeps_original_recycle_behavior():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        recommended = add_recommendation(db, '未招呼', 'geek-2', greeted=False)
        svc = DiscoveryService(db, None)
        svc.delete_recommendation(recommended.id)
        assert db.get(RecommendedCandidateRecord, recommended.id) is None
        assert db.get(RecommendationHiddenRecord, recommended.id) is None
        assert db.get(RecommendationRecycleRecord, recommended.identity_key) is not None
        assert svc.recommendations().candidates == []
    engine.dispose()

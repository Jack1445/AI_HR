import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ActionRecord, CandidateRecord, CommunicationRecycleRecord, JobCandidateRecord, RecommendedCandidateRecord
from app.db.session import get_db
from app.core.json_utils import dumps, loads
from app.core.config import get_settings
from app.services.boss_readonly import get_boss_cli_adapter
from app.services.operation_lock import manual_read_lock

router = APIRouter(prefix='/api/conversations', tags=['conversations'])


class SendText(BaseModel):
    job_id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=2000)
    request_id: UUID
    confirmed: bool


def target_for(db: Session, candidate_id: str, job_id: str) -> dict[str, str]:
    candidate = db.get(CandidateRecord, candidate_id)
    relation = db.scalar(select(JobCandidateRecord).where(
        JobCandidateRecord.candidate_id == candidate_id, JobCandidateRecord.job_id == job_id))
    if candidate is None or relation is None or not candidate.remote_id or not relation.remote_job_text:
        raise HTTPException(404, '未找到该岗位下的 BOSS 会话，请先同步')
    if db.get(CommunicationRecycleRecord, candidate.remote_id):
        raise HTTPException(409, '该候选人已在回收站，未打开会话')
    target = {'id': candidate_id, 'sourceId': candidate.remote_id, 'name': candidate.name,
              'job': relation.remote_job_text, 'recentTime': relation.remote_time}
    identity = loads(relation.source_snapshot, {}).get('recommendation_identity')
    if identity:
        recommendation = db.scalar(select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.identity_key == identity))
        if recommendation:
            target['baseInfo'] = loads(recommendation.person_json, {}).get('baseInfo', '')
    return target


@router.get('/{candidate_id}')
async def read_conversation(candidate_id: str, job_id: str, db: Session = Depends(get_db)):
    if manual_read_lock.locked():
        raise HTTPException(409, 'BOSS 正在执行其他任务，请稍后刷新会话')
    async with manual_read_lock:
        target = target_for(db, candidate_id, job_id)
        try:
            result = await get_boss_cli_adapter().run('conversation', '--target', dumps(target))
            return json.loads(result.stdout)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(502, str(exc)[:500]) from exc


@router.post('/{candidate_id}/send')
async def send_conversation(candidate_id: str, payload: SendText, db: Session = Depends(get_db)):
    if not payload.confirmed:
        raise HTTPException(400, '发送前必须由用户确认')
    if manual_read_lock.locked():
        raise HTTPException(409, 'BOSS 正在执行其他任务，请稍后发送')
    async with manual_read_lock:
        if get_settings().automation_emergency_stop:
            raise HTTPException(409, '紧急停止开关已开启，未发送')
        target = target_for(db, candidate_id, payload.job_id)
        text = payload.text.strip()
        if not text:
            raise HTTPException(400, '消息不能为空')
        if '\n' in text or '\r' in text:
            raise HTTPException(400, '当前仅支持单条文字消息，请把换行改为空格')
        key = f'conversation:{payload.request_id}:{candidate_id}'
        existing = db.scalar(select(ActionRecord).where(ActionRecord.idempotency_key == key))
        if existing:
            return {'status': existing.status, 'error': loads(existing.result_json, {}).get('error', ''), 'messages': []}
        row = ActionRecord(action_type='send_message', candidate_id=candidate_id, job_id=payload.job_id,
                           payload_json=dumps({'text': text}), status='executing', idempotency_key=key,
                           created_by='local', confirmed_by='local')
        db.add(row)
        db.commit()
        try:
            result = await get_boss_cli_adapter().run('conversation', '--target', dumps(target), f'--text={text}')
            data = json.loads(result.stdout)
            row.status = 'success'
            row.result_json = dumps({'sent': True})
            db.commit()
            return {'status': 'success', 'error': '', 'messages': data['messages']}
        except (ValueError, RuntimeError) as exc:
            row.status = 'failed'
            row.result_json = dumps({'error': str(exc)[:500]})
            db.commit()
            return {'status': 'failed', 'error': str(exc)[:500], 'messages': []}

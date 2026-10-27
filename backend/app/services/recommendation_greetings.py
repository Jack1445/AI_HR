"""Explicitly confirmed, serial greetings. Never retry a possibly sent message."""
import json
import logging
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from sqlalchemy import select

from app.core.config import get_settings
from app.core.greeting_identity import identity
from app.db.models import (AuditEventRecord, RecommendedCandidateRecord, RecommendationJobRecord,
                           RecommendationGreetingBatchRecord as Batch,
                           RecommendationGreetingLedgerRecord as Ledger, now_utc)
from app.db.session import SessionLocal
from app.services.boss_readonly import get_boss_cli_adapter
from app.services.discovery import DiscoveryService

logger = logging.getLogger(__name__)
ACTIVE = ('queued', 'running')
DONE = ('sent', 'already')


class GreetingRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    job_key: str = Field(min_length=1, max_length=64)
    candidate_ids: list[str] = Field(min_length=1, max_length=200)
    confirmed: Literal[True]

    @field_validator('confirmed', mode='before')
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError('请明确确认本次名单')
        return value


class CLIOutcome(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal[1]
    geek_id: str
    job_label: str
    attempted: StrictBool
    outcome: Literal['sent', 'already', 'clicked', 'not_found', 'mismatch', 'blocked']
    detail: str = Field(max_length=1000)


def view(row):
    items = json.loads(row.items_json)
    return dict(id=row.id, job_key=row.job_key, job_label=row.job_label, status=row.status,
                created_at=row.created_at, finished_at=row.finished_at, items=items,
                total=len(items), completed=sum(i['status'] not in ('pending', 'executing') for i in items),
                sent=sum(i['status'] == 'sent' for i in items),
                already=sum(i['status'] == 'already' for i in items))


def existing_request(db, payload):
    row = db.get(Batch, str(payload.request_id))
    if row and (row.job_key != payload.job_key or
                [i['candidate_id'] for i in json.loads(row.items_json)] != list(dict.fromkeys(payload.candidate_ids))):
        raise ValueError('请求编号已用于其他名单，请重新确认')
    return row


def create_batch(db, payload):
    existing = existing_request(db, payload)
    if existing:
        return existing
    if get_settings().automation_emergency_stop:
        raise ValueError('紧急停止已开启，不能打招呼')
    if db.scalar(select(Batch.id).where(Batch.status.in_(ACTIVE)).limit(1)):
        raise ValueError('已有打招呼任务正在执行，请等待完成')
    job = db.get(RecommendationJobRecord, payload.job_key)
    if not job or not job.available:
        raise ValueError('所选岗位不可用，请先刷新 BOSS 岗位')
    items, seen = [], set()
    for candidate_id in dict.fromkeys(payload.candidate_ids):
        row = db.get(RecommendedCandidateRecord, candidate_id)
        if not row or row.deleted_at or DiscoveryService.job_key(row.source_job) != payload.job_key:
            raise ValueError('名单中有人已删除或不属于当前岗位，请刷新后重新选择')
        person = json.loads(row.person_json)
        geek_id = person.get('geekId', '')
        if not all(isinstance(v, str) and v.strip() for v in (geek_id, person.get('name'), person.get('baseInfo'))):
            raise ValueError('所选人选缺少 ID、姓名或基本信息，请重新读取后再试')
        if geek_id in seen:
            raise ValueError('名单存在重复的 BOSS ID，请先核对本地记录')
        seen.add(geek_id)
        items.append(dict(candidate_id=row.id, geek_id=geek_id, name=person['name'],
                          base_info=person['baseInfo'], status='pending', detail='等待执行'))
    batch = Batch(id=str(payload.request_id), job_key=job.id, job_label=job.label,
                  items_json=json.dumps(items, ensure_ascii=False), status='queued')
    db.add(batch)
    db.add(AuditEventRecord(actor='local-human', event_type='recommendation_greeting.confirmed',
                           target_type='greeting_batch', target_id=batch.id,
                           detail_json=json.dumps({'job_key': job.id, 'count': len(items)})))
    db.commit()
    return batch


def recover_interrupted_greetings(db):
    for batch in db.scalars(select(Batch).where(Batch.status.in_(ACTIVE))):
        items = json.loads(batch.items_json)
        for item in items:
            if item['status'] == 'executing':
                item.update(status='unknown', detail='服务中断，发送结果未确认；请到 BOSS 核实，不会自动重发')
            elif item['status'] == 'pending':
                item.update(status='skipped', detail='服务中断，未执行')
        batch.items_json = json.dumps(items, ensure_ascii=False)
        batch.status, batch.finished_at = 'interrupted', now_utc()
    for ledger in db.scalars(select(Ledger).where(Ledger.status == 'executing')):
        ledger.status = 'unknown'
    db.commit()


async def execute_batch(batch_id, session_factory=SessionLocal, adapter=None):
    adapter = adapter or get_boss_cli_adapter()
    with session_factory() as db:
        batch = db.get(Batch, batch_id)
        if not batch or batch.status != 'queued':
            return
        items = json.loads(batch.items_json)

        def save():
            batch.items_json = json.dumps(items, ensure_ascii=False)
            db.commit()

        batch.status = 'running'
        save()
        stop = ''
        for item in items:
            if stop or get_settings().automation_emergency_stop:
                stop = stop or '紧急停止已开启'
                item.update(status='skipped', detail=f'{stop}；此人未执行')
                save()
                continue
            ledger_key = identity(batch.job_key, item['geek_id'])
            previous = db.get(Ledger, ledger_key)
            if previous:
                item.update(status='already' if previous.status in DONE else 'unknown',
                            detail='此前已完成招呼，已跳过' if previous.status in DONE else '此前执行结果未确认，请到 BOSS 核实；本次未重发')
                save()
                continue
            # Revalidate the local target immediately before reserving the external attempt.
            person = db.get(RecommendedCandidateRecord, item['candidate_id'], populate_existing=True)
            if not person or person.deleted_at or DiscoveryService.job_key(person.source_job) != batch.job_key:
                item.update(status='mismatch', detail='本地记录已删除或岗位变化，未执行')
                save()
                continue
            ledger = Ledger(id=ledger_key, batch_id=batch.id, status='executing')
            db.add(ledger)
            item.update(status='executing', detail='正在核对 BOSS 岗位与身份')
            save()  # Durable reservation precedes the only external command.
            try:
                result = await adapter.run('recommend-greet', '--geek-id', item['geek_id'],
                    '--name', item['name'], '--base-info', item['base_info'], '--job-label', batch.job_label,
                    timeout_seconds=90)
                outcome = CLIOutcome.model_validate_json(result.stdout)
                if outcome.geek_id != item['geek_id'] or outcome.job_label != batch.job_label:
                    raise ValueError('CLI returned a different target')
                if outcome.outcome == 'sent' and not outcome.attempted:
                    raise ValueError('CLI returned inconsistent confirmation')
                item.update(status=outcome.outcome, detail=outcome.detail)
                if outcome.outcome in DONE:
                    ledger.status = outcome.outcome
                elif outcome.attempted:
                    ledger.status = 'unknown'
                else:
                    db.delete(ledger)
                if outcome.outcome in ('blocked', 'clicked'):
                    stop = 'BOSS 状态需要人工核实，后续招呼已停止'
            except Exception as exc:
                # CLI errors can include full arguments/PII. Keep only a safe error type in logs/UI.
                logger.warning('Greeting batch %s stopped (%s)', batch.id, type(exc).__name__)
                ledger.status = 'unknown'
                item.update(status='unknown', detail='BOSS 调用异常或超时，结果未确认；请到 BOSS 核实，不会自动重发')
                stop = '调用结果未确认，后续招呼已停止'
            db.add(AuditEventRecord(actor='local-human', event_type='recommendation_greeting.result',
                target_type='greeting_batch', target_id=batch.id,
                detail_json=json.dumps({'identity': ledger_key, 'status': item['status']})))
            save()
        batch.status = 'stopped' if stop else 'completed'
        batch.finished_at = now_utc()
        save()

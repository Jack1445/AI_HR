from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.db.models import (CandidateRecord, CommunicationAttachmentRecord, CommunicationRecycleRecord, JobCandidateRecord, CandidateTagRecord, CandidateNoteRecord, StageHistoryRecord, TimelineEventRecord, AIAnalysisRecord, ActionRecord, ResumeDocumentRecord)
from app.core.config import get_settings
from app.core.json_utils import loads
from app.schemas.tables import Scope, SaveConfig, SaveCells, DeleteRows
from app.services.table_store import TableStore, cleanup_table_row
from app.services.operation_lock import manual_read_lock
from app.services.discovery import DiscoveryService
from app.services.boss_readonly import get_boss_cli_adapter

router = APIRouter(prefix='/api/local/tables', tags=['table-management'])


@router.get('/{scope}')
def state(scope: Scope, db: Session = Depends(get_db)):
    return TableStore(db, scope).state()


@router.put('/{scope}/config')
def config(scope: Scope, payload: SaveConfig, db: Session = Depends(get_db)):
    return TableStore(db, scope).save_config(payload)


@router.put('/{scope}/cells')
def cells(scope: Scope, payload: SaveCells, db: Session = Depends(get_db)):
    return TableStore(db, scope).save_cells(payload)


def remove_communication(db: Session, candidate_id: str):
    row = db.get(CandidateRecord, candidate_id)
    if row is None:
        raise LookupError('候选人已删除，请刷新')
    files = []
    root = (Path(__file__).resolve().parents[4] / get_settings().data_dir / 'resumes').resolve()
    export_root = (Path(__file__).resolve().parents[4] / get_settings().data_dir / 'downloaded-resumes').resolve()
    for attachment in db.scalars(select(CommunicationAttachmentRecord).where(CommunicationAttachmentRecord.candidate_id == row.id)):
        export_path = (export_root / attachment.export_path).resolve()
        if not export_path.is_relative_to(export_root):
            raise ValueError('岗位附件文件不在本地下载目录，已停止删除')
        files.append(export_path)
    for document in db.scalars(select(ResumeDocumentRecord).where(ResumeDocumentRecord.candidate_id == row.id)):
        path = Path(document.stored_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[4] / path
        path = path.resolve()
        if not path.is_relative_to(root):
            raise ValueError('简历文件不在本地简历目录，已停止删除')
        files.append(path)
    # New linked records use the recommendation recycle entry as the shared
    # tombstone. Keep the old communication tombstone only for legacy rows
    # created before recommendation linking was introduced.
    linked = DiscoveryService(db, get_boss_cli_adapter()).recycle_linked_recommendations(row.id)
    if not linked and db.get(CommunicationRecycleRecord, row.remote_id) is None:
        db.add(CommunicationRecycleRecord(remote_id=row.remote_id, name=row.name, source_job=loads(row.source_snapshot, {}).get('job', '')))
    for model in (CommunicationAttachmentRecord, JobCandidateRecord, CandidateTagRecord, CandidateNoteRecord, StageHistoryRecord, TimelineEventRecord, AIAnalysisRecord, ActionRecord, ResumeDocumentRecord):
        db.execute(delete(model).where(model.candidate_id == row.id))
    cleanup_table_row(db, 'communications', row.id)
    db.delete(row)
    for path in files:
        path.unlink(missing_ok=True)
    db.commit()


@router.post('/{scope}/delete')
async def delete_rows(scope: Scope, payload: DeleteRows, db: Session = Depends(get_db)):
    if manual_read_lock.locked():
        raise HTTPException(409, '已有读取任务，请完成后再删除')
    deleted, errors = [], []
    async with manual_read_lock:
        svc = DiscoveryService(db, get_boss_cli_adapter()) if scope == 'recommendations' else None
        for record_id in dict.fromkeys(payload.record_ids):
            try:
                if svc:
                    svc.delete_recommendation(record_id)
                else:
                    remove_communication(db, record_id)
                deleted.append(record_id)
            except (LookupError, ValueError, OSError) as error:
                db.rollback()
                errors.append({'id': record_id, 'error': str(error)})
    return {'deleted': deleted, 'errors': errors}


@router.get('/communications/recycle-bin')
def communication_bin(db: Session = Depends(get_db)):
    return DiscoveryService(db, get_boss_cli_adapter()).recycle_bin(None).model_dump()['candidates']


@router.post('/communications/recycle-bin/{remote_id}/restore', status_code=204)
async def allow_again(remote_id: str, db: Session = Depends(get_db)):
    if manual_read_lock.locked():
        raise HTTPException(409, '已有读取任务，请完成后再操作回收站')
    async with manual_read_lock:
        try:
            DiscoveryService(db, get_boss_cli_adapter()).allow_recommendation_again(remote_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

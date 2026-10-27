"""Local table metadata and typed annotations, independent of remote snapshots."""
import math
from datetime import date
from sqlalchemy import select, delete, update
from sqlalchemy.orm import Session
from fastapi import HTTPException
from app.core.json_utils import dumps, loads
from app.db.models import TableWorkspaceRecord, TableCellRecord, RecommendedCandidateRecord, CandidateRecord
from app.schemas.tables import TableConfig, SaveConfig, SaveCells

SYSTEM_FIELDS = {
    'recommendations': {'name', 'base', 'expect', 'salary', 'fit', 'tags', 'resume', 'retrieved', 'source_job', 'notes'},
    'communications': {'name', 'communication', 'stage', 'message', 'time', 'unread', 'tags', 'synced', 'owner', 'notes'},
}


def cleanup_table_row(db: Session, scope: str, record_id: str):
    db.execute(delete(TableCellRecord).where(TableCellRecord.scope == scope, TableCellRecord.record_id == record_id))
    # Saved ordering holds IDs only; prune deleted IDs to keep configuration bounded.
    workspace = db.get(TableWorkspaceRecord, scope)
    if workspace:
        config = TableConfig.model_validate_json(workspace.config_json)
        for view in config.views:
            view.order = [key for key in view.order if key != record_id]
        workspace.config_json = config.model_dump_json()
        workspace.revision += 1


class TableStore:
    def __init__(self, db: Session, scope: str):
        self.db, self.scope = db, scope

    def workspace(self):
        row = self.db.get(TableWorkspaceRecord, self.scope)
        if row is None:
            # insert-on-conflict also handles two browser tabs initializing together.
            from sqlalchemy.dialects.sqlite import insert
            self.db.execute(insert(TableWorkspaceRecord).values(scope=self.scope, revision=0, config_json=TableConfig().model_dump_json()).on_conflict_do_nothing())
            self.db.commit()
            row = self.db.get(TableWorkspaceRecord, self.scope)
        return row

    def state(self):
        row = self.workspace()
        values = {}
        for cell in self.db.scalars(select(TableCellRecord).where(TableCellRecord.scope == self.scope)):
            values.setdefault(cell.record_id, {})[cell.field_id] = loads(cell.value_json, None)
        return {'revision': row.revision, 'config': loads(row.config_json, {}), 'values': values}

    def save_config(self, payload: SaveConfig):
        row = self.workspace()
        old = TableConfig.model_validate_json(row.config_json)
        fields = {f.id: f for f in payload.config.fields}
        known = SYSTEM_FIELDS[self.scope] | set(fields)
        for view in payload.config.views:
            references = {c.id for c in view.columns} | {f.field for f in view.filters} | {s.field for s in view.sorts} | ({view.group} if view.group else set())
            if references - known:
                raise HTTPException(422, '视图引用了不存在的字段')
        for f in old.fields:
            if f.id in fields and f.type != fields[f.id].type:
                raise HTTPException(422, '已有字段不可直接改变类型，请新增字段后迁移内容')
            if f.id in fields and set(f.options) - set(fields[f.id].options):
                raise HTTPException(422, '已有选项请保留，避免已有值失去含义；可以添加新选项')
        result = self.db.execute(update(TableWorkspaceRecord).where(TableWorkspaceRecord.scope == self.scope, TableWorkspaceRecord.revision == payload.revision).values(config_json=payload.config.model_dump_json(), revision=payload.revision + 1))
        if result.rowcount != 1:
            self.db.rollback()
            raise HTTPException(409, '另一个页面已更新表格配置，请刷新后重试')
        removed = {f.id for f in old.fields} - set(fields)
        if removed:
            self.db.execute(delete(TableCellRecord).where(TableCellRecord.scope == self.scope, TableCellRecord.field_id.in_(removed)))
        self.db.commit()
        return self.state()

    def save_cells(self, payload: SaveCells):
        workspace = self.workspace()
        fields = {f.id: f for f in TableConfig.model_validate_json(workspace.config_json).fields}
        field = fields.get(payload.field_id)
        # Local notes are deliberately separate from downloaded profile data.
        if field is None and payload.field_id != 'notes':
            raise HTTPException(422, '该字段不可编辑或已删除')
        kind = field.type if field else 'multiline'
        value = payload.value
        if value is not None:
            valid = False
            if kind in ('text', 'multiline'):
                valid = isinstance(value, str) and len(value) <= 10000
            elif kind == 'number':
                valid = type(value) in (int, float) and math.isfinite(value)
            elif kind == 'checkbox':
                valid = type(value) is bool
            elif kind == 'date':
                try:
                    valid = isinstance(value, str) and date.fromisoformat(value).isoformat() == value
                except (ValueError, TypeError):
                    valid = False
            elif kind == 'select':
                valid = value in field.options
            elif kind == 'multi':
                valid = isinstance(value, list) and all(isinstance(v, str) and v in field.options for v in value) and len(set(value)) == len(value)
            if not valid:
                raise HTTPException(422, '输入值与字段类型或选项不匹配')
        model = RecommendedCandidateRecord if self.scope == 'recommendations' else CandidateRecord
        ids = set(payload.record_ids)
        found = set(self.db.scalars(select(model.id).where(model.id.in_(ids))))
        if found != ids:
            raise HTTPException(404, '部分人选已删除，请刷新后重试')
        for record_id in ids:
            key = (self.scope, record_id, payload.field_id)
            cell = self.db.get(TableCellRecord, key)
            if value is None:
                if cell:
                    self.db.delete(cell)
            elif cell:
                cell.value_json = dumps(value)
            else:
                self.db.add(TableCellRecord(scope=self.scope, record_id=record_id, field_id=payload.field_id, value_json=dumps(value)))
        self.db.commit()
        return {'saved': len(ids)}

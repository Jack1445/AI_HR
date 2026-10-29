from typing import Any, Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator

Scope = Literal['recommendations', 'communications']
FieldType = Literal['text', 'multiline', 'number', 'date', 'select', 'multi', 'checkbox']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class TableField(StrictModel):
    id: str = Field(pattern=r'^custom_[a-zA-Z0-9_-]{1,50}$')
    name: str = Field(min_length=1, max_length=60)
    type: FieldType
    options: list[str] = Field(default_factory=list, max_length=100)


class ColumnConfig(StrictModel):
    id: str = Field(max_length=64)
    name: str = Field(default='', max_length=60)
    hidden: bool = False
    width: int = Field(default=160, ge=80, le=800)
    fixed: Literal['', 'left', 'right'] = ''


class FilterRule(StrictModel):
    field: str = Field(max_length=64)
    op: Literal['contains', 'not_contains', 'eq', 'neq', 'empty', 'not_empty', 'gt', 'gte', 'lt', 'lte']
    value: str = Field(default='', max_length=10000)


class FilterGroup(StrictModel):
    filters: list[FilterRule] = Field(min_length=1, max_length=30)
    conjunction: Literal['and', 'or'] = 'or'


class SortRule(StrictModel):
    field: str = Field(max_length=64)
    direction: Literal['asc', 'desc'] = 'asc'


class TableView(StrictModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=60)
    columns: list[ColumnConfig] = Field(default_factory=list, max_length=150)
    filters: list[FilterRule] = Field(default_factory=list, max_length=30)
    conjunction: Literal['and', 'or'] = 'and'
    filter_groups: list[FilterGroup] = Field(default_factory=list, max_length=10)
    sorts: list[SortRule] = Field(default_factory=list, max_length=10)
    group: str = Field(default='', max_length=64)
    collapsed: list[str] = Field(default_factory=list, max_length=1000)
    order: list[str] = Field(default_factory=list, max_length=100000)


class TableConfig(StrictModel):
    fields: list[TableField] = Field(default_factory=list, max_length=100)
    views: list[TableView] = Field(default_factory=lambda: [TableView(id='default', name='全部记录')], min_length=1, max_length=30)
    active_view: str = 'default'

    @model_validator(mode='after')
    def unique_ids(self):
        for rows in (self.fields, self.views):
            if len({r.id for r in rows}) != len(rows):
                raise ValueError('字段或视图 ID 不能重复')
        if self.active_view not in {v.id for v in self.views}:
            raise ValueError('当前视图不存在')
        for v in self.views:
            if len({c.id for c in v.columns}) != len(v.columns) or len(set(v.order)) != len(v.order):
                raise ValueError('列或行顺序不能重复')
            if v.filter_groups and (v.filters or sum(len(g.filters) for g in v.filter_groups) > 30):
                raise ValueError('请使用条件组配置筛选，且筛选条件总数不能超过 30 条')
        for f in self.fields:
            if not f.name.strip() or any(not x.strip() or len(x) > 100 for x in f.options) or len(set(f.options)) != len(f.options):
                raise ValueError('字段名称及选项不能为空或重复')
        return self


class SaveConfig(StrictModel):
    revision: int = Field(ge=0)
    config: TableConfig


class SaveCells(StrictModel):
    record_ids: list[str] = Field(min_length=1, max_length=500)
    field_id: str = Field(max_length=64)
    value: Any = None


class DeleteRows(StrictModel):
    record_ids: list[str] = Field(min_length=1, max_length=500)

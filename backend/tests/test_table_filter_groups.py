import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.schemas.tables import SaveConfig, TableConfig
from app.services.table_store import TableStore


def grouped_config() -> dict:
    return {
        'active_view': 'default',
        'views': [{
            'id': 'default', 'name': '全部记录', 'conjunction': 'and',
            'filter_groups': [
                {'conjunction': 'or', 'filters': [
                    {'field': 'tags', 'op': 'contains', 'value': '985'},
                    {'field': 'tags', 'op': 'contains', 'value': '211'},
                ]},
                {'conjunction': 'or', 'filters': [
                    {'field': 'base', 'op': 'contains', 'value': '27年应届'},
                    {'field': 'base', 'op': 'contains', 'value': '28年应届'},
                ]},
            ],
        }],
    }


def test_grouped_filters_save_and_reject_removed_field_references():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        store = TableStore(db, 'recommendations')
        saved = store.save_config(SaveConfig(revision=0, config=TableConfig.model_validate(grouped_config())))
        view = saved['config']['views'][0]
        assert view['conjunction'] == 'and'
        assert [g['conjunction'] for g in view['filter_groups']] == ['or', 'or']

        invalid = grouped_config()
        invalid['views'][0]['filter_groups'][1]['filters'][0]['field'] = 'custom_removed'
        with pytest.raises(HTTPException, match='不存在的字段'):
            store.save_config(SaveConfig(revision=saved['revision'], config=TableConfig.model_validate(invalid)))
    engine.dispose()


def test_legacy_flat_filters_remain_valid_and_groups_cannot_mix_with_them():
    legacy = TableConfig.model_validate({'views': [{
        'id': 'default', 'name': '全部记录', 'conjunction': 'or',
        'filters': [{'field': 'tags', 'op': 'contains', 'value': '985'}],
    }]})
    assert legacy.views[0].conjunction == 'or'
    assert legacy.views[0].filter_groups == []

    mixed = grouped_config()
    mixed['views'][0]['filters'] = [{'field': 'tags', 'op': 'contains', 'value': '985'}]
    with pytest.raises(ValidationError, match='请使用条件组'):
        TableConfig.model_validate(mixed)

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes.local_data import delete_template, update_template
from app.db.base import Base
from app.db.models import MessageTemplateRecord
from app.schemas.local import TemplateUpdate


def test_saved_template_can_be_updated_and_deleted():
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    with sessionmaker(engine)() as db:
        template = MessageTemplateRecord(name='要简历', content='原话术')
        db.add(template)
        db.commit()
        template_id = template.id

        updated = update_template(template_id, TemplateUpdate(content='修改后话术'), db)
        assert updated == {'id': template_id, 'name': '要简历', 'content': '修改后话术'}
        assert db.get(MessageTemplateRecord, template_id).content == '修改后话术'

        delete_template(template_id, db)
        assert db.get(MessageTemplateRecord, template_id) is None
        with pytest.raises(HTTPException) as exc:
            update_template(template_id, TemplateUpdate(content='再次修改'), db)
        assert exc.value.status_code == 404
    engine.dispose()

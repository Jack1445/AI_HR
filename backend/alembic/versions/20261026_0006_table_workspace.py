"""Persist table configuration, annotations and retrieval dates."""
from alembic import op
from app.db.models import TableWorkspaceRecord, TableCellRecord, RecommendationFirstCaptureRecord, CommunicationRecycleRecord

revision = '20261026_0006'
down_revision = '20261021_0005'
branch_labels = None
depends_on = None
MODELS = (TableWorkspaceRecord, TableCellRecord, RecommendationFirstCaptureRecord, CommunicationRecycleRecord)


def upgrade():
    for model in MODELS:
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    for model in reversed(MODELS):
        model.__table__.drop(bind=op.get_bind(), checkfirst=True)

"""Recommendation job catalog and job-scoped exclusions."""
from alembic import op
from app.db.models import RecommendationJobRecord, RecommendationRecycleJobRecord
revision = '20261026_0007'
down_revision = '20261026_0006'
branch_labels = None
depends_on = None


def upgrade():
    for model in (RecommendationJobRecord, RecommendationRecycleJobRecord):
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    for model in (RecommendationRecycleJobRecord, RecommendationJobRecord):
        model.__table__.drop(bind=op.get_bind(), checkfirst=True)

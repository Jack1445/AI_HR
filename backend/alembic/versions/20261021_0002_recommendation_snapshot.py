"""Separate cache for the manually requested recommendation sample."""
from alembic import op
from app.db.models import RecommendationSnapshotRecord

revision = '20261021_0002'
down_revision = '20261018_0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    RecommendationSnapshotRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    RecommendationSnapshotRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)

"""Minimal recommendation deletion identities."""
from alembic import op
from app.db.models import RecommendationRecycleRecord

revision = '20261021_0005'
down_revision = '20261021_0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    RecommendationRecycleRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    RecommendationRecycleRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)

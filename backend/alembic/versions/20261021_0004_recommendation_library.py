"""Accumulated recommendations with compound identity and soft deletion."""
from alembic import op
from app.db.models import RecommendedCandidateRecord

revision = '20261021_0004'
down_revision = '20261021_0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    RecommendedCandidateRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    RecommendedCandidateRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)

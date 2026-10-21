"""Locally stored screenshots for recommended candidates."""
from alembic import op
from app.db.models import RecommendedResumeRecord

revision = '20261021_0003'
down_revision = '20261021_0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    RecommendedResumeRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    RecommendedResumeRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)

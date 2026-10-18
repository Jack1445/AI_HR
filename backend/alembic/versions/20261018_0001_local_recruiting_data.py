"""create local recruiting data tables

Revision ID: 20261018_0001
Revises:
"""

from alembic import op

from app.db.base import Base

revision = "20261018_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Metadata is the single source of truth for this first local schema.
    # Keeping the migration idempotent makes it safe to run after the dev
    # server's create_all bootstrap.
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)

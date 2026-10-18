from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Shared declarative base for business models and Alembic migrations."""


from app.db import models  # noqa: E402,F401  # register tables for Alembic

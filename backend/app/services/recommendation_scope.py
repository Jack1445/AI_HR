"""The active recommendation library is the allow-list for communications.

The BOSS recommendation card ID and communication-session ID are different
identifiers.  The communication list also does not expose the candidate's
basic-info string, so linking is intentionally conservative: a name/job pair
is accepted only when it maps to exactly one active recommendation record.
"""

import hashlib
from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.json_utils import loads
from app.core.greeting_identity import identity as greeting_identity
from app.db.models import CandidateRecord, JobCandidateRecord, RecommendedCandidateRecord, RecommendationGreetingLedgerRecord


def normalize(value: str) -> str:
    return ' '.join((value or '').split())


def recommendation_job_title(label: str) -> str:
    """Return the job title portion from a BOSS recommendation label."""
    value = normalize(label)
    return normalize(value.split(' _ ', 1)[0])


def build_active_recommendation_index(db: Session, *, greeted_only: bool = False) -> dict[tuple[str, str], tuple[str, ...]]:
    """Index active recommendations; optionally require a confirmed greeting."""
    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    greeted = set()
    if greeted_only:
        greeted = set(db.scalars(
            select(RecommendationGreetingLedgerRecord.id)
            .where(RecommendationGreetingLedgerRecord.status == 'sent')
        ))
    greeted_identities: set[str] = set()
    rows = db.scalars(
        select(RecommendedCandidateRecord).where(RecommendedCandidateRecord.deleted_at.is_(None))
    ).all()
    for row in rows:
        person = loads(row.person_json, {})
        name = normalize(person.get('name', ''))
        job = recommendation_job_title(row.source_job)
        if name and job:
            grouped[(name, job)].append(row.identity_key)
            if greeted_only and person.get('geekId'):
                job_key = hashlib.sha256(normalize(row.source_job).encode('utf-8')).hexdigest()
                if greeting_identity(job_key, person['geekId']) in greeted:
                    greeted_identities.add(row.identity_key)
    # Check ambiguity against every active recommendation before applying the
    # greeting filter: an ungreeted namesake must not make a match appear safe.
    return {key: tuple(values) for key, values in grouped.items()
            if not greeted_only or len(values) == 1 and values[0] in greeted_identities}


def recommendation_identity_for_chat(
    index: dict[tuple[str, str], tuple[str, ...]], name: str, job: str,
) -> str | None:
    """Return an identity only for one unambiguous active recommendation."""
    values = index.get((normalize(name), normalize(job)), ())
    return values[0] if len(values) == 1 else None


def unambiguous_stored_chat_keys(db: Session) -> set[tuple[str, str]]:
    """Do not assign one recommendation to several same-name chat sessions."""
    rows = db.execute(
        select(CandidateRecord.name, JobCandidateRecord.remote_job_text)
        .join(JobCandidateRecord, JobCandidateRecord.candidate_id == CandidateRecord.id)
    ).all()
    counts = Counter((normalize(name), normalize(job)) for name, job in rows)
    return {key for key, count in counts.items() if count == 1}

import hashlib
import json


def identity(job_key: str, geek_id: str) -> str:
    """Stable key shared by the greeting ledger and the recommendation table."""
    return hashlib.sha256(json.dumps([job_key, geek_id]).encode()).hexdigest()

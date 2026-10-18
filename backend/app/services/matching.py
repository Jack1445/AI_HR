from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.json_utils import dumps, loads
from app.db.models import AIAnalysisRecord, CandidateRecord, JobRecord
from app.schemas.local import MatchResult


def _tokens(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,}", text.lower())
    return list(dict.fromkeys(words))


class MatchingService:
    provider = "deterministic"
    model = "rules-v1"
    prompt_version = "match-v1"

    def __init__(self, db: Session) -> None:
        self.db = db

    def analyze(self, candidate_id: str, job_id: str, force: bool = False) -> MatchResult:
        candidate = self.db.get(CandidateRecord, candidate_id)
        job = self.db.get(JobRecord, job_id)
        if candidate is None or job is None:
            raise LookupError("候选人或岗位不存在")
        candidate_data = loads(candidate.profile_json, {})
        candidate_snapshot = loads(candidate.source_snapshot, {})
        job_data = {"title": job.title, "meta": loads(job.meta_json, []), "stats": loads(job.stats_json, {})}
        source = dumps({"candidate": candidate_data, "candidate_snapshot": candidate_snapshot, "job": job_data})
        input_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
        if not force:
            cached = self.db.scalar(select(AIAnalysisRecord).where(AIAnalysisRecord.candidate_id == candidate_id, AIAnalysisRecord.job_id == job_id, AIAnalysisRecord.input_hash == input_hash).order_by(AIAnalysisRecord.created_at.desc()))
            if cached is not None:
                return self._result(cached)
        candidate_text = " ".join(str(value) for value in (*candidate_data.values(), *candidate_snapshot.values()))
        job_text = " ".join([job.title, *[str(x) for x in job_data["meta"]]])
        requirements = _tokens(job_text)
        candidate_tokens = set(_tokens(candidate_text))
        matched = [token for token in requirements if token in candidate_tokens]
        unknown = [token for token in requirements if token not in candidate_tokens]
        score = min(100, 40 + min(50, len(matched) * 10) + (10 if candidate_data else 0))
        must_haves = [{"requirement": token, "status": "supported" if token in candidate_tokens else "unknown", "evidence": "候选人资料文本中出现" if token in candidate_tokens else "当前资料没有足够证据"} for token in requirements[:12]]
        strengths = [f"资料中出现关键词：{token}" for token in matched[:6]]
        risks = [f"缺少可验证证据：{token}" for token in unknown[:6]]
        questions = [f"请确认候选人是否具备：{token}" for token in unknown[:5]]
        recommendation = "建议进入人工初筛" if score >= 60 else "建议补充信息后再判断"
        result = {"score": score, "recommendation": recommendation, "must_haves": must_haves, "strengths": strengths, "risks": risks, "questions": questions, "evidence": [{"source": "candidate_snapshot", "text": candidate_snapshot.get("message", "")}], "generated_at": datetime.now(timezone.utc).isoformat()}
        record = AIAnalysisRecord(candidate_id=candidate_id, job_id=job_id, provider=self.provider, model=self.model, prompt_version=self.prompt_version, input_hash=input_hash, result_json=dumps(result))
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return self._result(record)

    def _result(self, record: AIAnalysisRecord) -> MatchResult:
        data = loads(record.result_json, {})
        return MatchResult(analysis_id=record.id, candidate_id=record.candidate_id, job_id=record.job_id, provider=record.provider, model=record.model, score=data.get("score", 0), recommendation=data.get("recommendation", ""), must_haves=data.get("must_haves", []), strengths=data.get("strengths", []), risks=data.get("risks", []), questions=data.get("questions", []), evidence=data.get("evidence", []), generated_at=record.created_at)

from __future__ import annotations

import hashlib
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.json_utils import dumps, loads
from app.db.models import AuditEventRecord, CandidateRecord, ResumeDocumentRecord
from app.schemas.local import ResumeResponse


ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}


def _extract_text(path: Path, content_type: str) -> tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="replace"), "text-v1"
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader  # type: ignore

            return "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages), "pypdf-v1"
        except ImportError:
            raw = path.read_bytes().decode("latin-1", errors="ignore")
            fragments = re.findall(r"\(([^()]*)\)\s*T[Jj]", raw)
            return "\n".join(fragment.replace("\\n", "\n").replace("\\(", "(").replace("\\)", ")") for fragment in fragments), "pdf-basic-v1"
        except Exception:
            return "", "pdf-error-v1"
    if suffix == ".docx":
        try:
            from docx import Document  # type: ignore

            return "\n".join(paragraph.text for paragraph in Document(str(path)).paragraphs), "python-docx-v1"
        except ImportError:
            try:
                with zipfile.ZipFile(path) as archive:
                    root = ET.fromstring(archive.read("word/document.xml"))
                texts = [node.text or "" for node in root.iter() if node.tag.endswith("}t")]
                return " ".join(texts), "docx-xml-v1"
            except Exception:
                return "", "docx-error-v1"
        except Exception:
            return "", "docx-error-v1"
    return "", "unsupported-v1"


def _structured(text: str) -> dict[str, object]:
    emails = sorted(set(re.findall(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)))
    phones = sorted(set(re.findall(r"(?<!\d)(?:1[3-9]\d{9}|\+?\d[\d\s-]{8,}\d)(?!\d)", text)))
    return {"emails": emails, "phones": phones, "skills": [], "experience": [], "education": [], "evidence": "仅基于本地提取文本"}


class ResumeService:
    def __init__(self, db: Session, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.root = Path(__file__).resolve().parents[3] / settings.data_dir / "resumes"
        self.root.mkdir(parents=True, exist_ok=True)

    def _response(self, row: ResumeDocumentRecord) -> ResumeResponse:
        return ResumeResponse(id=row.id, candidate_id=row.candidate_id, original_name=row.original_name, content_type=row.content_type, size_bytes=row.size_bytes, sha256=row.sha256, extracted_text=row.extracted_text, structured=loads(row.structured_json, {}), parser_version=row.parser_version, status=row.status, created_at=row.created_at)

    def import_file(self, candidate_id: str, original_name: str, content_type: str, data: bytes) -> ResumeResponse:
        if self.db.get(CandidateRecord, candidate_id) is None:
            raise LookupError("未找到候选人")
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            raise ValueError("仅支持 PDF、DOCX、TXT、MD 文件")
        if len(data) > self.settings.max_resume_bytes:
            raise ValueError(f"文件超过 {self.settings.max_resume_bytes} 字节限制")
        if suffix == ".pdf" and data and not data.startswith(b"%PDF"):
            raise ValueError("PDF 文件头校验失败")
        if suffix == ".docx" and data and not data.startswith(b"PK"):
            raise ValueError("DOCX 文件头校验失败")
        digest = hashlib.sha256(data).hexdigest()
        existing = self.db.scalar(select(ResumeDocumentRecord).where(ResumeDocumentRecord.candidate_id == candidate_id, ResumeDocumentRecord.sha256 == digest))
        if existing is not None:
            return self._response(existing)
        row_id = hashlib.sha256(f"{candidate_id}:{digest}".encode("utf-8")).hexdigest()[:32]
        path = self.root / f"{row_id}{suffix}"
        path.write_bytes(data)
        extracted, parser_version = _extract_text(path, content_type)
        row = ResumeDocumentRecord(id=row_id, candidate_id=candidate_id, original_name=Path(original_name).name[:255], stored_path=str(path.relative_to(self.root.parent.parent)), content_type=content_type[:128], size_bytes=len(data), sha256=digest, extracted_text=extracted[:500000], structured_json=dumps(_structured(extracted)), parser_version=parser_version, status="parsed" if extracted else "stored_unparsed")
        self.db.add(row)
        self.db.add(AuditEventRecord(actor="local", event_type="resume_imported", target_type="resume", target_id=row_id, detail_json=dumps({"candidate_id": candidate_id, "sha256": digest, "size_bytes": len(data)})))
        self.db.commit()
        self.db.refresh(row)
        return self._response(row)

    def list(self, candidate_id: str) -> list[ResumeResponse]:
        rows = self.db.scalars(select(ResumeDocumentRecord).where(ResumeDocumentRecord.candidate_id == candidate_id).order_by(ResumeDocumentRecord.created_at.desc())).all()
        return [self._response(row) for row in rows]

    def get(self, resume_id: str) -> ResumeResponse:
        row = self.db.get(ResumeDocumentRecord, resume_id)
        if row is None:
            raise LookupError("未找到简历")
        return self._response(row)

    def path(self, resume_id: str) -> Path:
        row = self.db.get(ResumeDocumentRecord, resume_id)
        if row is None:
            raise LookupError("未找到简历")
        path = Path(row.stored_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[3] / path
        if not path.is_file():
            raise LookupError("简历文件已不存在")
        return path

    def reparse(self, resume_id: str) -> ResumeResponse:
        row = self.db.get(ResumeDocumentRecord, resume_id)
        path = self.path(resume_id)
        extracted, parser_version = _extract_text(path, row.content_type if row else "")
        if row is None:
            raise LookupError("未找到简历")
        row.extracted_text = extracted[:500000]
        row.structured_json = dumps(_structured(extracted))
        row.parser_version = parser_version
        row.status = "parsed" if extracted else "stored_unparsed"
        self.db.add(AuditEventRecord(actor="local", event_type="resume_reparsed", target_type="resume", target_id=row.id, detail_json=dumps({"parser_version": parser_version})))
        self.db.commit()
        self.db.refresh(row)
        return self._response(row)

    def search(self, query: str, candidate_id: str | None = None, limit: int = 50) -> list[ResumeResponse]:
        stmt = select(ResumeDocumentRecord).where(ResumeDocumentRecord.extracted_text.ilike(f"%{query.strip()}%"))
        if candidate_id:
            stmt = stmt.where(ResumeDocumentRecord.candidate_id == candidate_id)
        rows = self.db.scalars(stmt.order_by(ResumeDocumentRecord.created_at.desc()).limit(min(limit, 200))).all()
        return [self._response(row) for row in rows]

    def delete(self, resume_id: str) -> None:
        row = self.db.get(ResumeDocumentRecord, resume_id)
        if row is None:
            raise LookupError("未找到简历")
        path = Path(row.stored_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[3] / path
        if path.exists() and path.is_file():
            path.unlink()
        self.db.add(AuditEventRecord(actor="local", event_type="resume_deleted", target_type="resume", target_id=row.id, detail_json=dumps({"sha256": row.sha256})))
        self.db.delete(row)
        self.db.commit()

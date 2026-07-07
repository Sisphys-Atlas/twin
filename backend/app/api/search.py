"""Semantic + keyword search endpoint."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.kb.database import get_db
from app.kb.models import User
from app.kb.search import hybrid_search

router = APIRouter()


class SearchRequest(BaseModel):
    query: str
    chat_ids: list[int] | None = None
    top_k: int = 15


@router.post("/search")
def search(req: SearchRequest, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    results = hybrid_search(req.query, db, req.chat_ids, req.top_k)
    return {"query": req.query, "count": len(results), "results": results}

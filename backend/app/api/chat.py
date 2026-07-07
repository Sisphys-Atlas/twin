"""Chat endpoint — streams Gemini response via Server-Sent Events."""

import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.agent.query_agent import stream_answer
from app.core.security import get_current_user
from app.kb.database import get_db
from app.kb.models import User
from app.kb.search import resolve_workspace_chat_ids

router = APIRouter()


class ChatRequest(BaseModel):
    query: str
    chat_ids: list[int] | None = None
    workspace_id: int | None = None
    category_filter: str | None = None


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
def chat(req: ChatRequest, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Stream a grounded answer with citations as Server-Sent Events."""

    # Resolve chat scope: explicit list > workspace > all
    chat_ids = req.chat_ids
    if not chat_ids and req.workspace_id:
        chat_ids = resolve_workspace_chat_ids(req.workspace_id, req.category_filter, db)

    def generate():
        try:
            for event in stream_answer(req.query, db, chat_ids):
                yield _sse(event)
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)})
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

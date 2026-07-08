"""Style learning — extracts the user's writing style from their indexed messages."""

import json
from datetime import datetime
from pathlib import Path

import google.generativeai as genai
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import get_current_user, require_owner
from app.kb.database import get_db
from app.kb.models import Chat, Message, User

router = APIRouter()

STYLE_FILE = Path(__file__).parent.parent.parent / "style_profile.json"

_ANALYSIS_PROMPT = """\
You are analyzing real WhatsApp messages written by a specific person to build their style profile.

Here are {count} of their actual messages (most recent first):
---
{messages}
---

Generate a system prompt that lets an AI perfectly impersonate this person on WhatsApp.
The AI will be replying to incoming WhatsApp messages on their behalf — the recipient must not be able to tell the difference.

The system prompt must cover:
1. Language(s) used and how they mix them (Arabic/French/English — be specific)
2. Typical message length (1 word? 1 sentence? multiple sentences?)
3. Punctuation style (do they end with periods? never? ellipsis? multiple exclamation marks?)
4. Emoji usage (never / rarely / sometimes / often — and which ones)
5. How they greet and open a conversation
6. How they close or end a message
7. Their formality level (very casual / casual / semi-formal)
8. Recurring expressions, abbreviations, or signature phrases they use
9. How they say yes, no, or acknowledge something
10. How they handle requests for prices, orders, or information

Output ONLY the system prompt text, nothing else. Begin with:
"You are replying to WhatsApp messages on behalf of the account owner. Replicate their exact style — the recipient must not know they are talking to an AI."
Then give concrete, specific style instructions based on the messages above.
"""

_SUMMARY_PROMPT = """\
In one short sentence, describe the communication style of someone who writes these messages:

{messages}

One sentence only:"""


def load_style() -> dict | None:
    if STYLE_FILE.exists():
        try:
            return json.loads(STYLE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def save_style(data: dict):
    STYLE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("/style")
def get_style(_: User = Depends(get_current_user)):
    profile = load_style()
    if not profile:
        return {"exists": False}
    return {"exists": True, **profile}


def _run_learn(workspace_id: int, db: Session) -> dict:
    """Core style learning logic — called by the API endpoint and background tasks."""
    rows = (
        db.query(Message).join(Chat)
        .filter(
            Chat.workspace_id == workspace_id,
            Message.sender == "Me",
            Message.body.isnot(None),
            Message.message_type == "text",
        )
        .order_by(Message.timestamp.desc())
        .limit(250)
        .all()
    )

    sample = [m.body.strip() for m in rows if m.body and m.body.strip() and len(m.body.strip()) > 1][:200]

    if len(sample) < 10:
        return {
            "error": f"Only {len(sample)} messages found. Sync your chats first.",
            "count": len(sample),
        }

    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(settings.gemini_model)

    style_resp = model.generate_content(
        _ANALYSIS_PROMPT.format(count=len(sample), messages="\n".join(f"• {m}" for m in sample)),
        generation_config=genai.types.GenerationConfig(temperature=0.2),
    )
    summary_resp = model.generate_content(
        _SUMMARY_PROMPT.format(messages="\n".join(sample[:40])),
        generation_config=genai.types.GenerationConfig(temperature=0.2),
    )

    profile = load_style() or {}
    profile.update({
        "workspace_id": workspace_id,
        "system_prompt": style_resp.text.strip(),
        "summary": summary_resp.text.strip(),
        "message_count": len(sample),
        "generated_at": datetime.utcnow().isoformat(),
        "approved_since_last_learn": 0,
    })
    save_style(profile)
    return {"exists": True, **profile}


@router.post("/style/learn")
def learn_style(workspace_id: int = 1, db: Session = Depends(get_db), _: User = Depends(require_owner)):
    """Analyze the owner's own messages and generate a twin style profile."""
    return _run_learn(workspace_id, db)


@router.post("/style/signature")
def set_signature(body: dict, _: User = Depends(require_owner)):
    """Set or clear the signature appended to twin-composed messages."""
    profile = load_style() or {}
    profile["signature"] = body.get("signature", "").strip()
    save_style(profile)
    return {"ok": True, "signature": profile["signature"]}


@router.delete("/style")
def delete_style(_: User = Depends(require_owner)):
    if STYLE_FILE.exists():
        STYLE_FILE.unlink()
    return {"ok": True}

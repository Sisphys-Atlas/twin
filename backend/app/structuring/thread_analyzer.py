"""
Thread segmentation and Gemini summarization.

segment_threads  — pure Python, no API call
summarize_thread — one Gemini call per thread
"""

import json
import re

import google.generativeai as genai

from app.config import settings
from app.parsing.whatsapp_parser import ParsedMessage

THREAD_GAP_HOURS = 4.0

_SUMMARY_PROMPT = """\
Analyze this WhatsApp conversation thread. Respond with valid JSON only — no markdown fences.

Thread:
{thread_text}

Required JSON:
{{
  "summary": "1-2 sentence summary in English",
  "intent_tags": [],
  "key_entities": {{
    "people": [],
    "companies": [],
    "amounts": [],
    "dates": []
  }}
}}

Valid intent_tags (pick all that apply):
order, payment, negotiation, complaint, scheduling, delivery, contract, update, casual, other

Extract real names, company names, monetary amounts (include currency), and specific dates."""


def segment_threads(messages: list[ParsedMessage]) -> list[list[ParsedMessage]]:
    """Split real (non-system) messages into threads on gaps > THREAD_GAP_HOURS."""
    real = [m for m in messages if m.sender is not None]
    if not real:
        return []

    threads: list[list[ParsedMessage]] = []
    current: list[ParsedMessage] = [real[0]]

    for msg in real[1:]:
        gap_h = (msg.timestamp - current[-1].timestamp).total_seconds() / 3600
        if gap_h > THREAD_GAP_HOURS:
            threads.append(current)
            current = [msg]
        else:
            current.append(msg)

    threads.append(current)
    return threads


def _format_thread(messages: list[ParsedMessage]) -> str:
    lines = []
    for m in messages:
        if m.sender and m.body:
            ts = m.timestamp.strftime("%Y-%m-%d %H:%M")
            lines.append(f"[{ts}] {m.sender}: {m.body[:250]}")
    return "\n".join(lines)


def summarize_thread(messages: list[ParsedMessage]) -> dict:
    """
    Call Gemini to produce a summary, intent tags, and key entities for one thread.
    Falls back to empty values on any error so the pipeline never halts.
    """
    thread_text = _format_thread(messages)
    if not thread_text.strip():
        return {"summary": "", "intent_tags": [], "key_entities": {}}

    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(settings.gemini_model)

    prompt = _SUMMARY_PROMPT.format(thread_text=thread_text[:4000])

    try:
        response = model.generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(temperature=0.1),
        )
        raw = response.text.strip()
        # Strip markdown fences if the model adds them
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
        raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)
        return json.loads(raw)
    except Exception as exc:
        return {
            "summary": f"[summarization failed: {exc}]",
            "intent_tags": [],
            "key_entities": {},
        }

"""
WhatsApp .txt export parser.

Supports:
  - Android format:     DD/MM/YYYY, HH:MM - Sender: body
  - iOS format:         [DD/MM/YY, H:MM:SS AM/PM] Sender: body
  - iOS French:         [DD/MM/YYYY à HH:MM:SS] Sender: body
  - Arabic-Indic numerals (٠-٩) and Arabic comma (،)
  - Multi-line messages (continuation lines)
  - System messages (no sender)
  - Media attachments (<Media omitted> and "filename (file attached)")
  - Burst grouping: consecutive same-sender messages within 2 minutes
"""

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

# ---------------------------------------------------------------------------
# Character normalisation
# ---------------------------------------------------------------------------

_ARABIC_INDIC = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_EXT_ARABIC_INDIC = str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")
# Arabic AM/PM markers → English equivalents
_AR_AMPM = {"م": "PM", "ص": "AM"}

# Unicode directional / invisible marks that sometimes appear in sender names
_DIR_MARKS = re.compile(r"[\u200E\u200F\u202A-\u202E\u2066-\u2069]")

BURST_WINDOW_SECONDS = 120  # 2 minutes

# ---------------------------------------------------------------------------
# Message-line regex patterns
# Each captures three groups: (date_part, time_part, rest_of_line)
# ---------------------------------------------------------------------------

_PATTERNS: list[re.Pattern] = [
    # iOS with brackets: [D/M/YY, H:MM:SS AM/PM] or [D/M/YYYY, HH:MM]
    re.compile(
        r"^﻿?\[(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})[,\s]+"
        r"(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)\]\s*(.*)\s*$",
        re.UNICODE,
    ),
    # iOS French: [D/M/YYYY à HH:MM:SS]
    re.compile(
        r"^﻿?\[(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s+à\s+"
        r"(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)\s*$",
        re.UNICODE,
    ),
    # Android: D/M/YYYY, HH:MM [AM/PM] - rest  (comma may be Arabic ،)
    re.compile(
        r"^﻿?(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})[,،]\s+"
        r"(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm]|[مص])?)\s*[-–]\s*(.*)\s*$",
        re.UNICODE,
    ),
]

# Date formats tried in order for each candidate string
_DATE_FMTS = [
    "%d/%m/%Y", "%m/%d/%Y",
    "%d/%m/%y", "%m/%d/%y",
    "%d.%m.%Y", "%d.%m.%y",
    "%d-%m-%Y", "%Y-%m-%d",
]
# Time formats tried for each candidate string
_TIME_FMTS = [
    "%I:%M %p", "%H:%M",
    "%I:%M:%S %p", "%H:%M:%S",
    "%I:%M %p",   # narrow no-break space before AM/PM
    "%I:%M:%S %p",
]

# Media file extension classification
_VOICE_EXT  = {".opus", ".m4a", ".ogg", ".aac", ".amr", ".3gp"}
_IMAGE_EXT  = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp"}
_VIDEO_EXT  = {".mp4", ".mov", ".avi", ".mkv", ".3gpp"}
_PDF_EXT    = {".pdf"}
_DOC_EXT    = {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt"}

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ParsedMessage:
    timestamp: datetime
    sender: Optional[str]       # None for system messages
    body: str
    message_type: str           # text | voice | image | video | pdf | document | media | system
    media_filename: Optional[str] = None
    burst_id: Optional[int] = None
    position: int = 0


@dataclass
class ParseResult:
    messages: list[ParsedMessage] = field(default_factory=list)
    participants: list[str] = field(default_factory=list)
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    format_detected: str = "unknown"
    total_lines: int = 0
    parse_errors: int = 0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _normalize(text: str) -> str:
    """Translate Arabic-Indic digits to ASCII. Safe to apply to any text."""
    return text.translate(_ARABIC_INDIC).translate(_EXT_ARABIC_INDIC)


def _parse_datetime(date_s: str, time_s: str) -> Optional[datetime]:
    """Try every date×time format combination; return first match."""
    date_s = _normalize(date_s.strip())
    # AM/PM substitution applied only to the time fragment, never to message bodies
    time_s = _normalize(time_s.strip())
    for ar, en in _AR_AMPM.items():
        time_s = time_s.replace(ar, en)
    # Normalise date separators to /
    date_s = re.sub(r"[.\-]", "/", date_s)

    for dfmt in _DATE_FMTS:
        for tfmt in _TIME_FMTS:
            try:
                return datetime.strptime(f"{date_s} {time_s}", f"{dfmt} {tfmt}")
            except ValueError:
                continue
    return None


def _classify_media(filename: str) -> str:
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext in _VOICE_EXT:
        return "voice"
    if ext in _IMAGE_EXT:
        return "image"
    if ext in _VIDEO_EXT:
        return "video"
    if ext in _PDF_EXT:
        return "pdf"
    if ext in _DOC_EXT:
        return "document"
    return "media"


def _parse_body(body: str) -> tuple[str, str, Optional[str]]:
    """Return (clean_body, message_type, media_filename)."""
    stripped = body.strip()

    # Omitted media placeholder (with or without LTR mark prefix)
    clean = _DIR_MARKS.sub("", stripped)
    if clean in ("<Media omitted>", "image omitted", "video omitted",
                 "audio omitted", "sticker omitted", "document omitted",
                 "GIF omitted", "Contact card omitted"):
        return stripped, "media", None

    # "filename.ext (file attached)"
    m = re.match(r"^(.+\.\w{2,5})\s+\(file attached\)$", stripped, re.IGNORECASE)
    if m:
        fname = m.group(1)
        return stripped, _classify_media(fname), fname

    # Bare filename (some exports omit "(file attached)")
    m = re.match(
        r"^([\w\-]+\.(opus|m4a|ogg|aac|amr|jpg|jpeg|png|webp|pdf|mp4|mov))\s*$",
        stripped, re.IGNORECASE,
    )
    if m:
        fname = m.group(1)
        return stripped, _classify_media(fname), fname

    return stripped, "text", None


def _detect_format(lines: list[str]) -> str:
    ios = android = 0
    for line in lines[:40]:
        norm = _normalize(line)
        stripped = norm.lstrip("﻿")
        if stripped.startswith("["):
            ios += 1
        elif _PATTERNS[2].match(norm):
            android += 1
    if ios == 0 and android == 0:
        return "unknown"
    return "ios" if ios >= android else "android"


def _assign_bursts(messages: list[ParsedMessage]) -> None:
    """Group consecutive same-sender messages within BURST_WINDOW_SECONDS."""
    burst_id = 0
    i = 0
    while i < len(messages):
        msg = messages[i]
        if msg.sender is None:          # skip system messages
            i += 1
            continue

        msg.burst_id = burst_id
        j = i + 1
        while j < len(messages):
            nxt = messages[j]
            if nxt.sender != msg.sender:
                break
            gap = (nxt.timestamp - messages[j - 1].timestamp).total_seconds()
            if gap > BURST_WINDOW_SECONDS:
                break
            nxt.burst_id = burst_id
            j += 1

        burst_id += 1
        i = j if j > i else i + 1


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse(text: str) -> ParseResult:
    """Parse a WhatsApp .txt export into structured messages."""
    result = ParseResult()
    lines = text.splitlines()
    result.total_lines = len(lines)
    result.format_detected = _detect_format(lines)

    # Accumulator for the message currently being built
    cur_ts: Optional[datetime] = None
    cur_sender: Optional[str] = None
    cur_body_parts: list[str] = []
    cur_is_system = False

    # (timestamp, sender_or_None, body_text)
    raw: list[tuple[datetime, Optional[str], str]] = []

    def _flush() -> None:
        if cur_ts is None:
            return
        raw.append((cur_ts, None if cur_is_system else cur_sender,
                    "\n".join(cur_body_parts).strip()))

    for line in lines:
        norm = _normalize(line)
        matched = False

        for pat in _PATTERNS:
            m = pat.match(norm)
            if not m:
                continue

            ts = _parse_datetime(m.group(1), m.group(2))
            if ts is None:
                result.parse_errors += 1
                break

            _flush()
            cur_ts = ts
            cur_body_parts = []
            cur_is_system = False

            rest = m.group(3).strip()
            colon = rest.find(": ")
            if colon > 0:
                # "Sender: message body"
                cur_sender = _DIR_MARKS.sub("", rest[:colon]).strip()
                cur_body_parts = [rest[colon + 2:]]
            else:
                # System message — no sender
                cur_sender = None
                cur_body_parts = [rest]
                cur_is_system = True

            matched = True
            break

        if not matched and cur_ts is not None:
            cur_body_parts.append(line)  # continuation line

    _flush()

    # Build ParsedMessage objects
    participants: set[str] = set()
    for pos, (ts, sender, body) in enumerate(raw):
        clean_body, msg_type, media_fname = _parse_body(body)
        msg = ParsedMessage(
            timestamp=ts,
            sender=sender,
            body=clean_body,
            message_type="system" if sender is None else msg_type,
            media_filename=media_fname,
            position=pos,
        )
        result.messages.append(msg)
        if sender:
            participants.add(sender)

    _assign_bursts(result.messages)

    result.participants = sorted(participants)
    real = [m for m in result.messages if m.sender is not None]
    if real:
        result.date_from = real[0].timestamp
        result.date_to = real[-1].timestamp

    return result


def from_structured(messages: list[dict]) -> ParseResult:
    """Build a ParseResult directly from structured message dicts, bypassing
    the text-export regex parser entirely. Used by the WhatsApp bridge, which
    already has each message as a discrete object (timestamp, sender, body,
    type) — reconstructing a WhatsApp-export .txt file and re-parsing it with
    regex is a lossy, fragile round trip and unnecessary when the caller
    already has structured data.

    Each dict may contain:
      timestamp: int (unix seconds) — required
      sender: str | None — None means a system message
      body: str — required (may be a short placeholder like "audio", "sticker")
      message_type: str — defaults to "text"
    """
    result = ParseResult()
    result.format_detected = "structured"
    result.total_lines = len(messages)

    participants: set[str] = set()
    for pos, m in enumerate(messages):
        ts_raw = m.get("timestamp")
        if ts_raw is None:
            result.parse_errors += 1
            continue
        try:
            ts = datetime.fromtimestamp(int(ts_raw))
        except (TypeError, ValueError, OSError):
            result.parse_errors += 1
            continue

        sender = m.get("sender") or None
        body = (m.get("body") or "").strip()
        msg_type = m.get("message_type") or ("system" if sender is None else "text")

        result.messages.append(ParsedMessage(
            timestamp=ts,
            sender=sender,
            body=body,
            message_type=msg_type,
            media_filename=m.get("media_filename"),
            position=pos,
        ))
        if sender:
            participants.add(sender)

    _assign_bursts(result.messages)

    result.participants = sorted(participants)
    real = [m for m in result.messages if m.sender is not None]
    if real:
        result.date_from = real[0].timestamp
        result.date_to = real[-1].timestamp

    return result
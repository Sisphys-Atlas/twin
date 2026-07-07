"""
Embedding generation via Gemini gemini-embedding-001 (3072-dim).

Embeddings are stored as REAL[] in Postgres.
Cosine similarity is computed in Python (numpy) — no pgvector needed.
"""

import numpy as np
import google.generativeai as genai

from app.config import settings

EMBEDDING_MODEL = "models/gemini-embedding-001"
BATCH_SIZE = 50          # Gemini allows up to 100; 50 is safe


def _configure():
    genai.configure(api_key=settings.gemini_api_key)


def embed_texts(texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
    """
    Embed a list of texts in batches.
    Returns a list of float vectors, one per input text.
    """
    _configure()
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), BATCH_SIZE):
        batch = [t if t and t.strip() else "." for t in texts[i : i + BATCH_SIZE]]
        result = genai.embed_content(
            model=EMBEDDING_MODEL,
            content=batch,
            task_type=task_type,
        )
        emb = result["embedding"]
        # Single text → flat list; multiple texts → list of lists
        if emb and isinstance(emb[0], float):
            all_embeddings.append(emb)
        else:
            all_embeddings.extend(emb)

    return all_embeddings


def embed_query(query: str) -> list[float]:
    """Embed a single search query."""
    return embed_texts([query], task_type="RETRIEVAL_QUERY")[0]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / denom) if denom > 0 else 0.0

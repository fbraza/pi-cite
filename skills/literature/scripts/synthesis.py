"""
Unified literature synthesis helpers.

This module combines general literature review summarisation with the
preclinical extraction summary used by the legacy merged literature workflow.
"""

from __future__ import annotations

from collections import Counter
from typing import Dict, List, Optional


def classify_study_type(paper: Dict) -> str:
    publication_types = [str(x).lower() for x in paper.get("publication_types", [])]
    text = " ".join(publication_types)
    if "meta-analysis" in text or "systematic review" in text:
        return "Systematic review / meta-analysis"
    if "randomized controlled trial" in text:
        return "Randomized controlled trial"
    if "clinical trial" in text:
        return "Clinical study"
    if paper.get("is_preprint"):
        return "Preprint"

    abstract = f"{paper.get('title', '')} {paper.get('abstract', '')}".lower()
    if any(x in abstract for x in ["xenograft", "mouse", "mice", "in vivo"]):
        if any(y in abstract for y in ["cell line", "in vitro", "organoid"]):
            return "In vitro + in vivo"
        return "In vivo"
    if any(x in abstract for x in ["cell line", "in vitro", "organoid", "crispr"]):
        return "In vitro"
    return "Observational / other"


def classify_evidence_quality(paper: Dict) -> str:
    study_type = classify_study_type(paper)
    citation_count = int(paper.get("citation_count") or 0)
    if study_type in {"Systematic review / meta-analysis", "Randomized controlled trial"}:
        return "High"
    if study_type in {"Clinical study", "In vitro + in vivo"}:
        return "Moderate"
    if paper.get("is_preprint"):
        return "Preliminary (preprint)"
    if study_type in {"In vivo", "In vitro"}:
        return "Moderate" if citation_count >= 20 else "Low to moderate"
    return "Preliminary"


def summarize_papers(papers: List[Dict]) -> Dict:
    study_types = Counter(classify_study_type(p) for p in papers)
    evidence = Counter(classify_evidence_quality(p) for p in papers)
    years = [int(p.get("year")) for p in papers if str(p.get("year", "")).isdigit()]
    return {
        "total_papers": len(papers),
        "study_type_breakdown": dict(study_types),
        "evidence_quality_breakdown": dict(evidence),
        "year_range": [min(years), max(years)] if years else None,
    }


def generate_narrative(papers: List[Dict], topic: str = "") -> str:
    summary = summarize_papers(papers)
    lead = f"Literature synthesis for **{topic}**." if topic else "Literature synthesis."
    lines = [lead, "", f"- Papers reviewed: {summary['total_papers']}"]
    if summary["year_range"]:
        lines.append(f"- Year range: {summary['year_range'][0]}-{summary['year_range'][1]}")
    if summary["study_type_breakdown"]:
        lines.append("- Study types: " + ", ".join(f"{k} ({v})" for k, v in summary["study_type_breakdown"].items()))
    if summary["evidence_quality_breakdown"]:
        lines.append("- Evidence quality: " + ", ".join(f"{k} ({v})" for k, v in summary["evidence_quality_breakdown"].items()))

    top_titles = [p.get("title", "Untitled") for p in papers[:5]]
    if top_titles:
        lines.extend(["", "Top prioritised papers:"])
        lines.extend([f"{i + 1}. {title}" for i, title in enumerate(top_titles)])
    return "\n".join(lines)


def synthesize_literature(
    papers: List[Dict],
    experiments: Optional[List[Dict]] = None,
    topic: str = "",
    mode: str = "general",
) -> Dict:
    summary = summarize_papers(papers)
    summary["mode"] = mode
    summary["topic"] = topic
    summary["narrative_markdown"] = generate_narrative(papers, topic=topic)
    if experiments:
        summary["experiment_type_breakdown"] = dict(Counter(e.get("experiment_type", "unclassified") for e in experiments))
        summary["model_systems"] = dict(Counter(filter(None, [e.get("cell_lines") or e.get("animal_models") for e in experiments])))
    return summary

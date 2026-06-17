"""Generate the unified per-paper summary table for the literature skill."""

from __future__ import annotations

import csv
from typing import Dict, Iterable, List

from synthesis import classify_evidence_quality, classify_study_type


def _authors_year(paper: Dict) -> str:
    authors = paper.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in authors.split(";") if a.strip()]
    lead = authors[0] if authors else "Unknown"
    if len(authors) > 1 and "et al." not in lead:
        lead = f"{lead} et al."
    year = paper.get("year") or paper.get("publication_date", "")[:4] or "n.d."
    return f"{lead} ({year})"


def _identifier(paper: Dict) -> str:
    if paper.get("pmid"):
        return f"PMID:{paper['pmid']}"
    if paper.get("doi"):
        return paper["doi"]
    if paper.get("s2_id"):
        return paper["s2_id"]
    return "NA"


def _truncate(text: str, limit: int = 160) -> str:
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def build_table_rows(papers: List[Dict], experiments: List[Dict] | None = None, mode: str = "general") -> List[Dict]:
    experiment_map = {}
    for exp in experiments or []:
        key = exp.get("pmid") or exp.get("doi")
        if key:
            experiment_map[key] = exp

    rows = []
    for idx, paper in enumerate(papers, start=1):
        key = paper.get("pmid") or paper.get("doi")
        exp = experiment_map.get(key, {})
        row = {
            "#": idx,
            "PMID/DOI": _identifier(paper),
            "Authors (year)": _authors_year(paper),
            "Key Message": _truncate(paper.get("tldr") or paper.get("title") or ""),
            "Key Results": _truncate(paper.get("abstract") or exp.get("key_findings") or ""),
            "Key Methods": _truncate(
                "; ".join(filter(None, [
                    ", ".join(paper.get("publication_types", [])[:3]) if isinstance(paper.get("publication_types"), list) else "",
                    exp.get("assays", ""),
                    exp.get("endpoints", ""),
                ]))
            ),
            "Study Type": classify_study_type(paper),
            "Evidence Quality": classify_evidence_quality(paper),
        }
        if mode == "preclinical":
            row.update({
                "Experiment Type": exp.get("experiment_type", ""),
                "Model System": exp.get("cell_lines") or exp.get("animal_models") or "",
                "Assay/Endpoint": "; ".join(filter(None, [exp.get("assays", ""), exp.get("endpoints", "")])),
                "Finding Direction": exp.get("key_findings", ""),
            })
        rows.append(row)
    return rows


def rows_to_markdown(rows: Iterable[Dict]) -> str:
    rows = list(rows)
    if not rows:
        return "## Paper Summary Table\n\n_No papers available._\n"
    headers = list(rows[0].keys())
    out = ["## Paper Summary Table", "", "| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for row in rows:
        out.append("| " + " | ".join(str(row.get(header, "")).replace("\n", " ") for header in headers) + " |")
    return "\n".join(out) + "\n"


def write_csv(rows: Iterable[Dict], output_path: str) -> None:
    rows = list(rows)
    if not rows:
        return
    headers = list(rows[0].keys())
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)

"""Export markdown, CSV, and pickle outputs for the unified literature skill."""

from __future__ import annotations

import os
import pickle
from typing import Dict, List, Optional

from generate_table import build_table_rows, rows_to_markdown, write_csv
from synthesis import synthesize_literature


def export_all(
    papers: List[Dict],
    output_dir: str,
    topic: str = "",
    mode: str = "general",
    experiments: Optional[List[Dict]] = None,
) -> Dict:
    os.makedirs(output_dir, exist_ok=True)

    synthesis = synthesize_literature(papers, experiments=experiments, topic=topic, mode=mode)
    rows = build_table_rows(papers, experiments=experiments, mode=mode)

    markdown_path = os.path.join(output_dir, "literature_report.md")
    csv_path = os.path.join(output_dir, "paper_summary_table.csv")
    pickle_path = os.path.join(output_dir, "analysis_object.pkl")

    with open(markdown_path, "w", encoding="utf-8") as handle:
        handle.write("# Literature Report\n\n")
        handle.write(synthesis["narrative_markdown"])
        handle.write("\n\n")
        handle.write(rows_to_markdown(rows))

    write_csv(rows, csv_path)

    payload = {
        "topic": topic,
        "mode": mode,
        "papers": papers,
        "experiments": experiments or [],
        "synthesis": synthesis,
        "table_rows": rows,
    }
    with open(pickle_path, "wb") as handle:
        pickle.dump(payload, handle)

    return {
        "markdown": markdown_path,
        "csv": csv_path,
        "pickle": pickle_path,
        "rows": len(rows),
    }

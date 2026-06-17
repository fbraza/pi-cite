# Experiment Extraction Guide

**Workflow:** literature
**Purpose:** Keyword-based extraction approach, dictionaries, and limitations for classifying in vitro and in vivo experiments from paper abstracts.

---

## Overview

The `extract_all_experiments()` function parses paper abstracts to classify each paper into one of three categories:
- **in_vitro** — only cell-based experiments reported
- **in_vivo** — only animal model experiments reported
- **both** — both in vitro and in vivo experiments reported
- **unclassified** — insufficient information in abstract to classify

Extraction is keyword-based (not AI-based), operating on the abstract text. It is fast and reproducible but has known limitations (see below).

---

## Extraction Dictionaries

### In Vitro Keywords

These terms in the abstract signal cell-based experiments:

```python
IN_VITRO_KEYWORDS = [
    # Cell lines
    "cell line", "cell lines", "cancer cells", "tumor cells",
    "HeLa", "MCF-7", "A549", "HCT116", "PC-3", "LNCaP", "MDA-MB",
    "U87", "U251", "Jurkat", "THP-1", "RAW264", "HEK293",

    # Assay types
    "in vitro", "cell viability", "cell proliferation", "MTT assay",
    "CCK-8", "colony formation", "clonogenic", "wound healing",
    "scratch assay", "transwell", "invasion assay", "migration assay",
    "flow cytometry", "apoptosis", "cell cycle", "western blot",
    "immunofluorescence", "ELISA", "qPCR", "RNA-seq", "ChIP",

    # Culture conditions
    "cultured", "culture", "monolayer", "3D culture", "organoid",
    "spheroid", "primary cells", "iPSC", "stem cells"
]
```

### In Vivo Keywords

These terms signal animal model experiments:

```python
IN_VIVO_KEYWORDS = [
    # Animal models
    "in vivo", "mouse model", "murine", "mice", "rat model",
    "xenograft", "syngeneic", "PDX", "patient-derived xenograft",
    "transgenic", "knockout mouse", "knock-in", "GEM", "GEMM",
    "orthotopic", "subcutaneous tumor", "allograft",

    # Animal procedures
    "tumor volume", "tumor growth", "body weight", "survival",
    "tumor regression", "metastasis model", "lung metastasis",
    "liver metastasis", "intracranial", "intraperitoneal injection",
    "intravenous injection", "oral gavage", "dosing",

    # Animal species
    "C57BL/6", "BALB/c", "nude mice", "SCID", "NOD-SCID",
    "NSG", "athymic", "immunodeficient", "Sprague-Dawley",
    "Wistar rat", "zebrafish"
]
```

---

## Extraction Logic

```python
def classify_paper(abstract: str) -> dict:
    """
    Classify a paper abstract into experiment categories.
    Returns dict with: experiment_type, in_vitro_signals, in_vivo_signals,
                       cell_lines, animal_models, assays, endpoints, findings
    """
    abstract_lower = abstract.lower()

    # Count keyword matches
    in_vitro_hits = [kw for kw in IN_VITRO_KEYWORDS if kw.lower() in abstract_lower]
    in_vivo_hits = [kw for kw in IN_VIVO_KEYWORDS if kw.lower() in abstract_lower]

    # Classify
    has_vitro = len(in_vitro_hits) >= 1
    has_vivo = len(in_vivo_hits) >= 1

    if has_vitro and has_vivo:
        experiment_type = "both"
    elif has_vitro:
        experiment_type = "in_vitro"
    elif has_vivo:
        experiment_type = "in_vivo"
    else:
        experiment_type = "unclassified"

    return {
        "experiment_type": experiment_type,
        "in_vitro_signals": in_vitro_hits,
        "in_vivo_signals": in_vivo_hits,
        "cell_lines": extract_cell_lines(abstract),
        "animal_models": extract_animal_models(abstract),
        "assays": extract_assays(abstract),
        "endpoints": extract_endpoints(abstract),
        "findings": extract_findings_sentence(abstract)
    }
```

---

## Structured Field Extraction

Beyond classification, the script extracts specific structured fields:

### Cell Lines
Extracted using a curated regex pattern matching common cancer cell line names:
```python
CELL_LINE_PATTERN = r'\b(MCF-7|MDA-MB-\d+|A549|HCT116|PC-3|LNCaP|HeLa|U87|U251|Jurkat|THP-1|HEK293[T]?|Caco-2|SW480|HT-29|PANC-1|MiaPaCa|BxPC-3|DU145|22Rv1)\b'
```

### Animal Models
```python
ANIMAL_MODEL_PATTERN = r'\b(xenograft|syngeneic|PDX|patient-derived xenograft|transgenic|knockout|GEMM|orthotopic|allograft|C57BL/6|BALB/c|nude mice|NSG|SCID)\b'
```

### Assay Types
```python
ASSAY_PATTERN = r'\b(MTT|CCK-8|colony formation|clonogenic|wound healing|transwell|flow cytometry|western blot|ELISA|qPCR|RNA-seq|ChIP-seq|ATAC-seq|immunofluorescence|IHC|co-immunoprecipitation)\b'
```

### Endpoints
```python
ENDPOINT_PATTERN = r'\b(tumor volume|tumor growth|survival|body weight|metastasis|apoptosis|cell viability|proliferation|migration|invasion|angiogenesis|tumor regression)\b'
```

### Key Findings Sentence
The script extracts the last 1-2 sentences of the abstract as a proxy for the main finding:
```python
def extract_findings_sentence(abstract: str) -> str:
    sentences = abstract.split(". ")
    return ". ".join(sentences[-2:]).strip()
```

---

## Output Schema

The `experiment_extraction.csv` file contains one row per paper with these columns:

| Column | Type | Description |
|--------|------|-------------|
| `pmid` | str | PubMed ID |
| `doi` | str | DOI |
| `title` | str | Paper title |
| `year` | int | Publication year |
| `experiment_type` | str | in_vitro / in_vivo / both / unclassified |
| `cell_lines` | str | Comma-separated cell line names found |
| `animal_models` | str | Comma-separated animal model terms found |
| `assays` | str | Comma-separated assay types found |
| `endpoints` | str | Comma-separated endpoints found |
| `in_vitro_signal_count` | int | Number of in vitro keyword matches |
| `in_vivo_signal_count` | int | Number of in vivo keyword matches |
| `key_findings` | str | Last 1-2 sentences of abstract |

---

## Known Limitations

### 1. Abstract-only extraction
The script only reads abstracts, not full text. Papers that describe experiments only in the methods/results sections (not the abstract) will be misclassified as "unclassified".

**Mitigation:** Step 5 of the workflow (full-text enrichment) addresses this for top papers.

### 2. Keyword sensitivity
- **False positives:** A paper mentioning "mouse model" in the introduction (not as an experiment performed) may be classified as in_vivo.
- **False negatives:** Novel cell lines or animal models not in the dictionary will be missed.

### 3. No quantitative extraction
The script does not extract dosing, IC50 values, tumor volumes, or statistical significance — only qualitative classification.

### 4. Language dependency
Only English-language abstracts are supported. Non-English papers will be classified as "unclassified".

### 5. High "unclassified" rate for some targets
For niche targets or highly mechanistic papers (e.g., structural biology, computational studies), most papers may be classified as "unclassified". This is expected behavior — not a bug.

---

## Improving Extraction for Your Target

If you find too many "unclassified" papers, you can extend the keyword dictionaries:

```python
# Add target-specific cell lines
CUSTOM_CELL_LINES = ["your_cell_line_1", "your_cell_line_2"]
IN_VITRO_KEYWORDS.extend(CUSTOM_CELL_LINES)

# Add target-specific animal models
CUSTOM_ANIMAL_MODELS = ["your_model_1", "your_model_2"]
IN_VIVO_KEYWORDS.extend(CUSTOM_ANIMAL_MODELS)
```

Edit `scripts/extract_experiments.py` directly and re-run Step 2.

---

## References

- Keyword extraction approach inspired by: Lever J, et al. (2019) *PLOS Biol* — text mining for biomedical literature
- Cell line nomenclature: ATCC (https://www.atcc.org/)
- Animal model terminology: NCI Thesaurus (https://ncithesaurus.nci.nih.gov/)

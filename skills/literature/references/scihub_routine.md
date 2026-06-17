# Sci-Hub PDF Resolver — Routine Quick-Reference

Resolves DOIs to direct PDF URLs via Sci-Hub mirrors. **Always check institutional access and open-access sources first** (PubMed Central, publisher OA). Use Sci-Hub only as a last resort.

**Script:** `scripts/scihub_pdf_resolver.py` — zero-dependency Python script.

## CLI Usage

```bash
python scripts/scihub_pdf_resolver.py "10.1038/s41586-024-07000-0"
```

## Output Codes

| Output | Meaning |
|---|---|
| Prints a URL | Direct PDF link, ready to download |
| `NOT_FOUND` | Sci-Hub does not have this paper. Check for `OA_LINK <url>` for open-access alternatives. |
| `MIRROR_ERROR` | Sci-Hub mirrors could not be reached reliably |
| `INVALID_INPUT` | The DOI is malformed |

## Exit Codes

`0` = found, `1` = not found, `2` = mirror error, `3` = invalid input.

## Python API

```python
from scripts.scihub_pdf_resolver import resolve_pdf

status, url = resolve_pdf("10.1038/s41586-024-07000-0")
if status == "FOUND":
    print(f"PDF available at: {url}")
elif status == "NOT_FOUND" and url:
    print(f"Open-access link: {url}")
```

## Mirror Configuration

Set `SCIHUB_MIRRORS` environment variable (comma-separated URLs) to override defaults. Defaults: `sci-hub.st`, `sci-hub.ru`, `sci-hub.se`.

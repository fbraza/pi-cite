import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = String.raw`
import contextlib
import csv
import io
import json
import os
import pickle
import sys
import tempfile

sys.path.insert(0, "skills/literature/scripts")
from generate_table import build_table_rows
from export_all import export_all
from extract_experiments import extract_all_experiments

paper = {
    "pmid": "12345",
    "doi": "10.1000/example",
    "title": "Example paper",
    "abstract": "Example abstract.",
    "authors": ["Smith J"],
    "year": "2024",
}

scenario = sys.argv[1]
if scenario == "default":
    general = build_table_rows([paper])
    preclinical = build_table_rows([paper], mode="preclinical")
    print(json.dumps({"general": list(general[0]), "preclinical": list(preclinical[0])}))
elif scenario == "full_text":
    paper["evidence_source"] = "Europe PMC OA full-text excerpt"
    rows = build_table_rows([paper], full_text_requested=True)
    print(json.dumps({"headers": list(rows[0]), "source": rows[0]["Evidence Source"]}))
elif scenario == "missing_provenance":
    build_table_rows([paper], full_text_requested=True)
elif scenario == "exports":
    with tempfile.TemporaryDirectory() as directory:
        outputs = {}
        for full_text in [False, True]:
            paper["evidence_source"] = "Europe PMC OA full-text excerpt"
            destination = os.path.join(directory, str(full_text))
            paths = export_all([paper], destination, full_text_requested=full_text)
            with open(paths["csv"], newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            with open(paths["markdown"], encoding="utf-8") as handle:
                markdown = handle.read()
            with open(paths["pickle"], "rb") as handle:
                payload = pickle.load(handle)
            outputs[str(full_text)] = {"row": rows[0], "markdown": markdown,
                                       "table_row": payload["table_rows"][0]}
        del paper["evidence_source"]
        destination = os.path.join(directory, "invalid")
        try:
            export_all([paper], destination, full_text_requested=True)
        except ValueError:
            outputs["invalid_directory_exists"] = os.path.exists(destination)
        print(json.dumps(outputs))
elif scenario == "extraction":
    with tempfile.TemporaryDirectory() as directory:
        paper["abstract"] = "In vitro macrophages showed increased cytokine production."
        with contextlib.redirect_stdout(io.StringIO()):
            experiments = extract_all_experiments([paper], directory)
        with open(os.path.join(directory, "experiment_extraction.csv"), newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        empty_dir = os.path.join(directory, "empty")
        with contextlib.redirect_stdout(io.StringIO()):
            empty = extract_all_experiments([], empty_dir)
        print(json.dumps({"experiments": experiments, "rows": rows, "empty": empty,
                          "empty_size": os.path.getsize(os.path.join(empty_dir, "experiment_extraction.csv"))}))
`;

function runPython(scenario: string) {
	return spawnSync("python3", ["-c", script, scenario], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
}

const generalHeaders = [
	"#",
	"PMID/DOI",
	"In Zotero",
	"Authors (year)",
	"Key Message",
	"Key Results",
	"Key Methods",
	"Study Type",
	"Evidence Quality",
	"DOI",
	"Access Link",
];

test("literature table default headers remain exactly backward compatible", () => {
	const result = runPython("default");
	assert.equal(result.status, 0, result.stderr);
	const headers = JSON.parse(result.stdout);
	assert.deepEqual(headers.general, generalHeaders);
	assert.deepEqual(headers.preclinical, [
		...generalHeaders.slice(0, -2),
		"Experiment Type",
		"Model System",
		"Assay/Endpoint",
		"Finding Direction",
		"DOI",
		"Access Link",
	]);
});

test("full-text opt-in appends explicit evidence provenance", () => {
	const result = runPython("full_text");
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(output.headers, [...generalHeaders, "Evidence Source"]);
	assert.equal(output.source, "Europe PMC OA full-text excerpt");
});

test("full-text opt-in fails clearly when evidence provenance is missing", () => {
	const result = runPython("missing_provenance");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Evidence provenance is required for PMID:12345/);
	assert.match(result.stderr, /set evidence_source explicitly for every paper/);
});

test("exports preserve default tables and carry opt-in provenance through markdown, CSV and pickle", () => {
	const result = runPython("exports");
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(Object.keys(output.False.row), generalHeaders);
	assert.doesNotMatch(output.False.markdown, /Evidence Source/);
	assert.deepEqual(Object.keys(output.True.row), [
		...generalHeaders,
		"Evidence Source",
	]);
	assert.equal(
		output.True.row["Evidence Source"],
		"Europe PMC OA full-text excerpt",
	);
	assert.equal(
		output.True.table_row["Evidence Source"],
		"Europe PMC OA full-text excerpt",
	);
	assert.match(output.True.markdown, /\| Evidence Source \|/);
	assert.equal(output.invalid_directory_exists, false);
});

test("preclinical extraction writes populated and empty CSVs without pandas", () => {
	const result = runPython("extraction");
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.experiments[0].experiment_type, "in_vitro");
	assert.equal(output.rows[0].pmid, "12345");
	assert.equal(output.rows[0].experiment_type, "in_vitro");
	assert.deepEqual(output.empty, []);
	assert.equal(output.empty_size, 0);
});

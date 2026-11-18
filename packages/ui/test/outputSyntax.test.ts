import { describe, expect, it } from "vitest";
import { detectOutputSyntax, formatOutputForDisplay } from "../src/lib/outputSyntax.js";

describe("detectOutputSyntax", () => {
  it("detects JSON documents", () => {
    expect(detectOutputSyntax('{"a":1}')).toBe("json");
    expect(detectOutputSyntax("[1,2,3]")).toBe("json");
    expect(detectOutputSyntax('  {"a": [true, null, "s"]}  ')).toBe("json");
  });

  it("detects JSON lines", () => {
    expect(detectOutputSyntax('{"a":1}\n{"b":2}')).toBe("jsonl");
  });

  it("detects XML", () => {
    expect(detectOutputSyntax('<?xml version="1.0"?>\n<root/>')).toBe("xml");
    expect(detectOutputSyntax("<root>\n  <child/>\n</root>")).toBe("xml");
  });

  it("detects TOML", () => {
    expect(detectOutputSyntax('[server]\nhost = "localhost"\nport = 8080')).toBe("toml");
  });

  it("detects YAML maps and lists", () => {
    expect(detectOutputSyntax("name: app\nversion: 1.2.3\nenabled: true")).toBe("yaml");
    expect(detectOutputSyntax("- alpha\n- beta")).toBe("yaml");
    expect(detectOutputSyntax("---\nname: app")).toBe("yaml");
  });

  it("detects CSV and TSV", () => {
    expect(detectOutputSyntax("a,b,c\n1,2,3")).toBe("csv");
    expect(detectOutputSyntax("a\tb\n1\t2")).toBe("tsv");
  });

  it("rejects prose, logs and oversized output", () => {
    expect(detectOutputSyntax("hello world")).toBe(null);
    expect(
      detectOutputSyntax("2026-11-18 12:00:00 INFO: started\n2026-11-18 12:00:01 INFO: ready"),
    ).toBe(null);
    expect(detectOutputSyntax("{not json}")).toBe(null);
    expect(detectOutputSyntax(`{"a":"${"x".repeat(64_001)}"}`)).toBe(null);
  });
});

describe("formatOutputForDisplay", () => {
  it("pretty-prints JSON", () => {
    expect(formatOutputForDisplay('{"a":1,"b":[1,2]}', "json")).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    );
  });

  it("aligns CSV and TSV columns", () => {
    expect(formatOutputForDisplay("name,age\nAna,3\nBob,42", "csv")).toBe(
      "name  age\nAna   3\nBob   42",
    );
    expect(formatOutputForDisplay("a\tb\n1\t22", "tsv")).toBe("a  b\n1  22");
  });

  it("keeps YAML/TOML/XML untouched", () => {
    expect(formatOutputForDisplay("a: 1\nb: 2", "yaml")).toBe("a: 1\nb: 2");
    expect(formatOutputForDisplay("<root/>", "xml")).toBe("<root/>");
  });
});

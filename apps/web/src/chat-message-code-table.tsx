import React, { useState } from "react";
import { renderInlineMarkdown } from "./chat-message-sources";

export function escapeCsvValue(val: string): string {
  const str = String(val ?? "").trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const RenderedTableBlock = React.memo(function RenderedTableBlock({
  headers,
  rows,
  sourceTitles,
}: {
  headers: string[];
  rows: string[][];
  sourceTitles: Map<string, string>;
}) {
  const [copied, setCopied] = useState(false);

  function exportCsv() {
    const csvContent =
      "\uFEFF" +
      [
        headers.map(escapeCsvValue).join(","),
        ...rows.map((r) => r.map(escapeCsvValue).join(",")),
      ].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "edited_table.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyCsv() {
    const csvContent = [
      headers.map(escapeCsvValue).join(","),
      ...rows.map((r) => r.map(escapeCsvValue).join(",")),
    ].join("\n");
    navigator.clipboard.writeText(csvContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isIndexHeader = (h?: string) => Boolean(h && /^([#№]|no\.?|id)$/i.test(h.trim()));

  return (
    <div className="chat-table-wrapper">
      <div className="chat-table-header">
        <div className="chat-table-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="9" x2="9" y2="21" />
            <line x1="15" y1="9" x2="15" y2="21" />
          </svg>
          <span>Table ({rows.length} {rows.length === 1 ? "row" : "rows"})</span>
        </div>
        <div className="chat-table-actions">
          <button type="button" className={`chat-action-btn ${copied ? "copied" : ""}`} onClick={copyCsv} title="Copy CSV">
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy CSV</span>
              </>
            )}
          </button>
          <button type="button" className="chat-action-btn download" onClick={exportCsv} title="Download table as Excel / CSV">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download Excel / CSV</span>
          </button>
        </div>
      </div>
      <div className="chat-table-scroll">
        <table className="chat-rendered-table">
          <thead>
            <tr>
              {headers.map((h, idx) => (
                <th key={idx} className={isIndexHeader(h) ? "th-index" : ""}>
                  {renderInlineMarkdown(h, false, sourceTitles)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => {
              const rowKey = row[0] ? `row-${row[0]}-${rIdx}` : `row-${rIdx}`;
              return (
                <tr key={rowKey}>
                  {row.map((cell, cIdx) => {
                    const isIndex = isIndexHeader(headers[cIdx]);
                    const isPrimary = cIdx === 0 && !isIndex;
                    return (
                      <td
                        key={cIdx}
                        className={isIndex ? "td-index" : isPrimary ? "td-primary-cell" : ""}
                      >
                        {cell ? renderInlineMarkdown(cell, false, sourceTitles) : "\u00A0"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

export function RenderedCodeBlock({
  code,
  lang,
  filename,
}: {
  code: string;
  lang: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);

  function copyText() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadFile() {
    const ext = filename
      ? filename.split(".").pop() || "txt"
      : lang === "csv" ? "csv"
      : lang === "tsv" ? "tsv"
      : lang === "json" ? "json"
      : lang === "python" || lang === "py" ? "py"
      : lang === "typescript" || lang === "ts" ? "ts"
      : lang === "javascript" || lang === "js" ? "js"
      : lang === "html" ? "html"
      : lang === "css" ? "css"
      : lang === "sql" ? "sql"
      : lang === "yaml" || lang === "yml" ? "yaml"
      : "txt";

    const name = filename || `export.${ext}`;
    const isCsvOrTsv = ext === "csv" || ext === "tsv";
    const content = isCsvOrTsv ? "\uFEFF" + code : code;
    const blob = new Blob([content], { type: isCsvOrTsv ? "text/csv;charset=utf-8;" : "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="chat-code-block-wrapper">
      <div className="chat-code-header">
        <span className="chat-code-lang">{filename || lang || "code"}</span>
        <div className="chat-code-actions">
          <button type="button" className="chat-action-btn" onClick={copyText} title="Copy code">
            {copied ? "Copied!" : "Copy"}
          </button>
          <button type="button" className="chat-action-btn download" onClick={downloadFile} title="Download file">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download {lang === "csv" ? "CSV / Excel" : "file"}</span>
          </button>
        </div>
      </div>
      <pre className="chat-code-pre"><code>{code}</code></pre>
    </div>
  );
}

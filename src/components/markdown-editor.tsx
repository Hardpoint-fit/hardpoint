"use client";

// A Markdown text box with WRITE and PREVIEW tabs, shared by the fit description and the comment, reply
// and edit boxes. The preview is rendered on the server by the same renderer the fit page uses
// (previewMarkdownAction), so what it shows is what will be posted; this component never renders Markdown
// itself. The textarea stays mounted while previewing so the text, caret and scroll are not lost.
import { useRef, useState } from "react";
import { previewMarkdownAction } from "#/app/actions";

type Preview = { status: "idle" } | { status: "loading" } | { status: "empty" } | { status: "ready"; html: string } | { status: "error"; message: string };

export function MarkdownEditor({
  value,
  onChange,
  maxLength,
  placeholder,
  label,
  required,
  tall,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder?: string;
  /** The textarea's accessible name. */
  label: string;
  required?: boolean;
  tall?: boolean;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  // A slow answer to an earlier PREVIEW click must not overwrite a later one.
  const latest = useRef(0);

  const show = async (next: "write" | "preview") => {
    setTab(next);
    if (next === "write") return;
    const request = ++latest.current;
    if (value.trim() === "") return setPreview({ status: "empty" });
    setPreview({ status: "loading" });
    let result: Awaited<ReturnType<typeof previewMarkdownAction>>;
    try {
      result = await previewMarkdownAction(value);
    } catch {
      if (request === latest.current) setPreview({ status: "error", message: "The preview couldn't be made. Try again." });
      return;
    }
    if (request !== latest.current) return;
    setPreview(result.ok ? { status: "ready", html: result.html } : { status: "error", message: result.message });
  };

  const tabButton = (name: "write" | "preview") => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === name}
      className={`btn btn--quiet ${tab === name ? "btn--on" : ""}`}
      onClick={() => void show(name)}
    >
      {name.toUpperCase()}
    </button>
  );

  return (
    <div className="md-editor">
      <div className="md-editor__tabs" role="tablist" aria-label="Write or preview">
        {tabButton("write")}
        {tabButton("preview")}
      </div>
      <textarea
        className={`textarea ${tall ? "textarea--tall" : ""}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label}
        // A hidden required box would block the form with a field nobody can focus.
        required={required && tab === "write"}
        hidden={tab !== "write"}
      />
      {tab === "preview" && (
        <div className="md-editor__preview" role="tabpanel" aria-label="Preview" aria-live="polite">
          {preview.status === "loading" && <p className="note">RENDERING</p>}
          {preview.status === "empty" && <p className="note">NOTHING TO PREVIEW YET.</p>}
          {preview.status === "error" && (
            <p className="note note--error" role="alert">
              {preview.message}
            </p>
          )}
          {/* The server's renderer escapes raw HTML and allows only http(s) links (markdown.ts). */}
          {preview.status === "ready" && <div className="prose" dangerouslySetInnerHTML={{ __html: preview.html }} />}
        </div>
      )}
    </div>
  );
}

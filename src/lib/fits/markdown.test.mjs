import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./markdown.ts";

test("plain Markdown renders", () => {
  const html = renderMarkdown("# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<li>two<\/li>/);
});

test("a script tag is escaped, not emitted", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n\nhello <b>x</b> <img src=x onerror=alert(1)>");
  assert.equal(/<script/i.test(html), false);
  assert.equal(/<b>/i.test(html), false);
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});

test("raw HTML blocks and inline HTML are inert", () => {
  for (const source of [
    '<div onclick="x()">hi</div>',
    '<a href="https://x.test" onclick="x()">link</a>',
    "<iframe src='https://x.test'></iframe>",
    "<style>body{display:none}</style>",
  ]) {
    const html = renderMarkdown(source);
    assert.equal(/<(div|iframe|style)/i.test(html), false, html);
    // A linkified URL inside the escaped text is a legitimate anchor; every real tag must be ours.
    const tags = html.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) assert.match(tag, /^<\/?(p|a href="https?:[^"]*" rel="nofollow ugc noopener" target="_blank"|a)>$/, tag);
  }
});

test("only http and https links become anchors", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "javascript&#58;alert(1)",
    "&#106;avascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://x.test/a",
    "mailto:a@b.test",
    "//evil.test/x",
    "/relative",
  ]) {
    const html = renderMarkdown(`[click](${href})`);
    assert.equal(/<a[\s>]/.test(html), false, `${href} -> ${html}`);
    assert.equal(/href=/i.test(html), false, `${href} -> ${html}`);
  }
});

test("reference-style and autolinked javascript: links are inert too", () => {
  for (const source of ["[x][1]\n\n[1]: javascript:alert(1)", "<javascript:alert(1)>", "javascript:alert(1)"]) {
    const html = renderMarkdown(source);
    assert.equal(/href=/i.test(html), false, html);
  }
});

test("http(s) links carry rel nofollow ugc noopener", () => {
  const html = renderMarkdown("[a](https://example.com/x?y=1&z=2) and [b](http://example.com) and https://bare.example.com/p");
  const anchors = html.match(/<a [^>]*>/g) ?? [];
  assert.equal(anchors.length, 3);
  for (const anchor of anchors) {
    assert.match(anchor, /rel="nofollow ugc noopener"/);
    assert.match(anchor, /href="https?:\/\//);
  }
});

test("a quote in a link title or url cannot break out of the attribute", () => {
  const html = renderMarkdown('[a](https://example.com/"onmouseover="alert(1) "t\\" onfocus=\\"x")');
  assert.equal(/\sonmouseover=/.test(html), false, html);
  assert.equal(/\sonfocus=/.test(html), false, html);
});

test("images never render; their alt text stays as text", () => {
  for (const source of [
    "![alt text](https://example.com/a.png)",
    "![x](javascript:alert(1))",
    "![x](data:image/svg+xml;base64,AAAA)",
    "![x][r]\n\n[r]: https://example.com/a.png",
  ]) {
    const html = renderMarkdown(source);
    assert.equal(/<img/i.test(html), false, html);
    assert.equal(/<svg/i.test(html), false, html);
    assert.equal(/src=/i.test(html), false, html);
  }
  assert.match(renderMarkdown("![alt text](https://example.com/a.png)"), /alt text/);
});

test("data: URLs never reach an attribute", () => {
  const html = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)\n\n![y](data:image/png;base64,AA)");
  assert.equal(/href=|src=/i.test(html), false, html);
  assert.equal(/<script/i.test(html), false, html);
});

test("empty and whitespace input render to nothing harmful", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("   \n  ").trim(), "");
});

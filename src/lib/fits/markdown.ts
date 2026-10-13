// Markdown to HTML for fit descriptions and comments, rendered at read time. The source is stored as
// typed. Raw HTML is escaped, only http(s) links become anchors, and images never render.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });

// markdown-it normalizes and entity-decodes the destination before asking, so `javascript&#58;` and
// tab-split schemes arrive here already resolved.
md.validateLink = (url) => /^https?:\/\//i.test(url.trim());

const REL = "nofollow ugc noopener";

md.renderer.rules.link_open = (tokens, index) => {
  const href = String(tokens[index]!.attrGet("href") ?? "");
  return `<a href="${md.utils.escapeHtml(href)}" rel="${REL}" target="_blank">`;
};

// An image is just its alt text: remote images would leak readers' IPs and carry content nobody reviewed.
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index]!.content);

/** Sanitized HTML for a Markdown source. Safe to inject: every tag in the result comes from this module. */
export function renderMarkdown(source: string): string {
  return md.render(source);
}

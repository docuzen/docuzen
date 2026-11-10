// The two selection quick actions that run an agent: Brainstorm (a one-shot discuss
// turn streamed into the chat pane) and Visualize (a mermaid diagram proposed for the
// highlighted passage, with Insert into doc). Split out of surface.ts, which only wires
// them to the popover buttons. Reaches the chat pane and the document through `deps`.
import mermaid from "mermaid";
import { resolveAnchor } from "@ai-native-doc/docd/anchor";
import type { TextQuoteAnchor } from "@ai-native-doc/docd/anchor";
import type { RpcEvent } from "@ai-native-doc/docd/protocol";
import type { HtmlSurfaceDeps } from "./surface.js";
import { startWaitStatus } from "./wait-status.js";
import { insertDiagramIntoHtmlDoc } from "./html-diagram-insert.js";
import { lastAgentReply, reportError } from "./ui.js";

/**
 * Insert a fenced block into the doc markdown as its own paragraph, right after
 * the line containing the anchor's matched text (separated by blank lines). Uses
 * `resolveAnchor` (fuzzy-tolerant) to locate the selection in the raw markdown,
 * which correctly handles inline formatting (e.g. `**bold**` → anchor.exact "bold")
 * and multi-paragraph selections (anchor uses single `\n`; markdown uses `\n\n`).
 * Falls back to appending at the document end when the anchor does not resolve.
 *
 * Exported at module level so it can be unit-tested independently of `initHtmlSurface`.
 */
export function insertBlockAfterQuote(
  markdown: string,
  anchor: TextQuoteAnchor,
  block: string,
): string {
  const range = resolveAnchor(markdown, anchor);
  if (!range) {
    return markdown.replace(/\s*$/, "") + `\n\n${block}\n`;
  }
  // Advance to the end of the line containing the matched span.
  const lineEnd = markdown.indexOf("\n", range.end);
  const insertAt = lineEnd === -1 ? markdown.length : lineEnd;
  const before = markdown.slice(0, insertAt);
  const after = markdown.slice(insertAt);
  return `${before}\n\n${block}\n${after}`;
}

export type SelectionAgentActionsDeps = Pick<HtmlSurfaceDeps, "activateChatPane" | "api" | "appendCustomTurn" | "beginExclusiveTurn" | "chatTurn" | "endExclusiveTurn" | "getCurrentMarkdown" | "getDocPath" | "getFormat" | "getHtmlSurface" | "getModelId" | "getStance" | "log" | "markDiscussed" | "modelName" | "nextMermaidSeq" | "reloadActiveDoc" | "routeProposal" | "scrollTurnsToBottom" | "setChatBusy" | "setChip" | "streamingAgentTurn">;

export interface SelectionAgentActionsApi {
  runBrainstorm: (id: string, quoted: string) => Promise<void>;
  runVisualize: (id: string, quoted: string, anchor: TextQuoteAnchor) => Promise<void>;
}

export function initSelectionAgentActions(deps: SelectionAgentActionsDeps): SelectionAgentActionsApi {
  /** See ui.ts's lastAgentReply (shared with the other pane module). */
  const fetchLastAgentReply = (threadId: string) => lastAgentReply(deps.api, deps.getDocPath, threadId);

  /** Stream a one-shot discuss turn into the chat pane (used by Brainstorm). */
  async function runBrainstorm(id: string, quoted: string): Promise<void> {
    if (!deps.getDocPath()) return;
    if (!deps.beginExclusiveTurn(id, "brainstorm")) return;
    let ok = false;
    deps.activateChatPane(id, quoted);
    deps.chatTurn("you", "Brainstorm options for this passage.");
    const bubble = deps.streamingAgentTurn(deps.getStance());
    const modelId = deps.getModelId();
    deps.setChip(id, "running");
    deps.setChatBusy(id); // show Stop; cancelKey for discuss is docPath#<id>
    try {
      await deps.api.discuss(
        {
          threadId: id,
          annotationId: id,
          stance: deps.getStance(),
          comment:
            "Brainstorm options, alternatives, and improvements for this passage. Give a concise bulleted list.",
          ...(modelId ? { modelId } : {}),
        },
        (e: RpcEvent) => {
          if (deps.routeProposal(e)) return;
          bubble.onEvent(e);
        },
      );
      bubble.done(await fetchLastAgentReply(id));
      deps.markDiscussed(id);
      deps.setChip(id, "responded");
      ok = true;
    } catch (e) {
      bubble.fail(String(e));
      deps.setChip(id, "error");
      reportError("brainstorm", e, deps.log);
    } finally {
      deps.setChatBusy(null);
      deps.endExclusiveTurn(id, ok);
    }
  }

  /**
   * Extract a fenced code block (```…```) from an agent reply, dropping any
   * surrounding prose. Takes from the first ``` fence to its matching closer; if
   * there's no complete fence, returns the whole reply trimmed.
   */
  function extractFencedBlock(reply: string): string {
    const open = reply.indexOf("```");
    if (open === -1) return reply.trim();
    const close = reply.indexOf("```", open + 3);
    if (close === -1) return reply.trim();
    return reply.slice(open, close + 3).trim();
  }


  /** The mermaid source inside a ```mermaid fenced block. */
  function mermaidSource(block: string): string {
    return block.replace(/^```mermaid\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  /** Render mermaid `src` into `container`, falling back to showing the source on error. */
  async function renderMermaidInto(container: HTMLElement, src: string): Promise<void> {
    try {
      const { svg } = await mermaid.render(`mermaid-chat-${deps.nextMermaidSeq()}`, src);
      container.className = "mermaid-rendered";
      container.innerHTML = svg;
    } catch {
      container.className = "mermaid-error";
      container.textContent = src;
    }
  }

  /** Stream a visualize turn into a proposal-style box; offer Insert into doc. */
  async function runVisualize(id: string, quoted: string, anchor: TextQuoteAnchor): Promise<void> {
    if (!deps.getDocPath()) return;
    if (!deps.beginExclusiveTurn(id, "visualize")) return;
    deps.activateChatPane(id, quoted);
    const box = document.createElement("div");
    box.className = "proposal";
    box.innerHTML = `<div class="ptitle">Proposed diagram</div>
    <div class="dpreview"></div>
    <pre class="pnew"></pre>
    <div class="pacts"><button class="papply" disabled>Insert into doc</button><button class="preject">Reject</button></div>`;
    const preview = box.querySelector<HTMLDivElement>(".dpreview")!;
    const pre = box.querySelector<HTMLPreElement>(".pnew")!;
    const insertBtn = box.querySelector<HTMLButtonElement>(".papply")!;
    box.querySelector<HTMLButtonElement>(".preject")!.addEventListener("click", () => box.remove());
    deps.appendCustomTurn(box);

    deps.setChatBusy(id); // show Stop; cancelKey for visualize is docPath#<id>
    let result: { diagram: string };
    // Until the diagram source starts streaming, say what is happening and for how long.
    const status = startWaitStatus(pre, "Waiting for the model…");
    let streaming = false;
    try {
      result = await deps.api.visualize({ threadId: id }, (e) => {
        if (e.event === "thinking") status.set("The agent is thinking…");
        if (e.event === "token") {
          if (!streaming) {
            streaming = true;
            status.stop();
            pre.textContent = "";
          }
          pre.textContent += String(e.data);
          deps.scrollTurnsToBottom();
        }
      });
    } catch (e) {
      pre.textContent = `⚠ ${String(e)}`;
      return;
    } finally {
      status.stop();
      deps.setChatBusy(null);
      deps.endExclusiveTurn(id, true); // adds no conversation turn; queued messages may proceed
    }

    const block = extractFencedBlock(result.diagram);
    if (!block.trim()) {
      pre.className = "pnew empty-reply";
      pre.textContent =
        `⚠ No diagram from ${deps.modelName(deps.getModelId() ?? "") || "the model"} — it returned no content.` +
        " Check the model in File ▸ Settings: a wrong/forbidden model id, an unreachable" +
        " gateway, or rate-limiting all look like this.";
      return; // nothing to render or insert
    }
    pre.textContent = block; // show the clean fenced source under the rendered preview
    void renderMermaidInto(preview, mermaidSource(block)); // show the actual diagram
    insertBtn.disabled = false;
    insertBtn.addEventListener("click", async () => {
      const docPath = deps.getDocPath();
      if (!docPath) return;
      insertBtn.disabled = true;
      try {
        let newText: string;
        if (deps.getFormat() === "html") {
          // An HTML file has no mermaid renderer, so it gets the rendered SVG in a <figure>
          // after the selected block (a markdown fence would be saved as literal text).
          const surface = deps.getHtmlSurface();
          const doc = surface?.doc;
          if (!surface || !doc) throw new Error("the HTML document is not loaded");
          // A document-unique id: mermaid scopes the SVG's styles to it.
          const svgId = `docuzen-diagram-${Date.now().toString(36)}-${deps.nextMermaidSeq()}`;
          const { svg } = await mermaid.render(svgId, mermaidSource(block));
          insertDiagramIntoHtmlDoc(doc, anchor, svg, mermaidSource(block));
          newText = surface.getHtml();
        } else {
          newText = insertBlockAfterQuote(deps.getCurrentMarkdown(), anchor, block);
        }
        await deps.api.saveDoc({ text: newText });
        deps.log(`inserted diagram for ${id}`);
        box.remove();
        await deps.reloadActiveDoc();
      } catch (e) {
        reportError("diagram insert", e, deps.log);
        // Say so in the box: the log is not somewhere a reviewer looks.
        let err = box.querySelector<HTMLDivElement>(".perror");
        if (!err) {
          err = document.createElement("div");
          err.className = "perror";
          box.appendChild(err);
        }
        err.textContent = `⚠ Could not insert the diagram: ${String(e)}`;
        insertBtn.disabled = false;
      }
    });
  }

  return { runBrainstorm, runVisualize };
}

// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/kit/core", () => ({ editorViewCtx: Symbol("view") }));
vi.mock("@milkdown/kit/preset/commonmark", () => ({ imageSchema: { node: {}, extendSchema: () => ({ node: {} }) } }));
vi.mock("@milkdown/kit/utils", () => ({ $view: (_n: unknown, f: unknown) => f }));

import {
  altFromName,
  imageFilesFrom,
  initDocImages,
  localImagePath,
  makeImageView,
  resolveImageSrc,
  rewriteHtmlImages,
  sidecarImageUrl,
  storedImageName,
  withImageFallback,
  type DocImagesDeps,
} from "./doc-images.js";
import { serializeDocument } from "./html-surface.js";

const DOC = "/Users/me/notes/plan.md";
const PORT = 4321;
const served = (path: string) => `http://127.0.0.1:${PORT}/image?path=${encodeURIComponent(path)}`;

describe("resolving image links", () => {
  it("resolves relative, parent-relative, absolute and file: links against the document", () => {
    expect(localImagePath(DOC, "pics/a.png")).toBe("/Users/me/notes/pics/a.png");
    expect(localImagePath(DOC, "./pics/../b%20c.png")).toBe("/Users/me/notes/b c.png");
    expect(localImagePath(DOC, "../.docuzen/notes/plan.md.had/assets/x.png")).toBe("/Users/me/.docuzen/notes/plan.md.had/assets/x.png");
    expect(localImagePath(DOC, "/abs/p.png?v=2#frag")).toBe("/abs/p.png");
    expect(localImagePath(DOC, "file:///abs/my%20p.png")).toBe("/abs/my p.png");
    expect(localImagePath(DOC, "file://localhost/abs/p.png")).toBe("/abs/p.png");
    // A single slash is a valid file URI too (RFC 8089).
    expect(localImagePath(DOC, "file:/abs/my%20p.png")).toBe("/abs/my p.png");
  });

  it("leaves web, data and blob images alone", () => {
    for (const src of ["https://x.test/a.png", "http://x.test/a.png", "data:image/png;base64,AAAA", "blob:abc", "//cdn.test/a.png", ""]) {
      expect(localImagePath(DOC, src)).toBeNull();
      expect(resolveImageSrc(DOC, src, PORT)).toBe(src);
    }
  });

  it("serves local images through the sidecar, and only images", () => {
    expect(resolveImageSrc(DOC, "pics/a b.png", PORT)).toBe(served("/Users/me/notes/pics/a b.png"));
    expect(resolveImageSrc(DOC, "secrets.txt", PORT)).toBe("secrets.txt");
    expect(resolveImageSrc(undefined, "pics/a.png", PORT)).toBe("pics/a.png");
  });
});

describe("the sidecar's image URL", () => {
  it("carries the launch token, and the fallback still finds the file path in it", async () => {
    (globalThis as { __DOCD_TOKEN__?: string }).__DOCD_TOKEN__ = "s3cret+/";
    try {
      const url = resolveImageSrc(DOC, "pics/a b.png", PORT);
      expect(url).toBe(`${served("/Users/me/notes/pics/a b.png")}&token=s3cret%2B%2F`);
      expect(sidecarImageUrl("/x/y.png", PORT)).toBe(`${served("/x/y.png")}&token=s3cret%2B%2F`);
      // A load failure falls back to reading the file over RPC: by its path, not the token.
      const img = document.createElement("img");
      const read = vi.fn(async () => ({ mime: "image/png", dataBase64: "AAAA" }));
      withImageFallback(img, read);
      img.setAttribute("src", url);
      img.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
      expect(read).toHaveBeenCalledWith("/Users/me/notes/pics/a b.png");
    } finally {
      delete (globalThis as { __DOCD_TOKEN__?: string }).__DOCD_TOKEN__;
    }
  });
});

describe("naming", () => {
  it("keeps real file names, timestamps clipboard images, and adds a missing extension", () => {
    const now = new Date(2026, 10, 11, 9, 5, 7);
    expect(storedImageName({ name: "diagram.PNG", type: "image/png" }, now)).toBe("diagram.PNG");
    expect(storedImageName({ name: "image.png", type: "image/png" }, now)).toBe("pasted-20261111-090507.png");
    expect(storedImageName({ name: "", type: "image/jpeg" }, now)).toBe("pasted-20261111-090507.jpg");
    expect(storedImageName({ name: "chart", type: "image/webp" }, now)).toBe("chart.webp");
    expect(altFromName("release-plan_v2.png")).toBe("release plan v2");
  });

  it("picks only the image files out of a drop", () => {
    const files = [
      new File(["x"], "a.png", { type: "image/png" }),
      new File(["x"], "notes.txt", { type: "text/plain" }),
      new File(["x"], "b.JPG", { type: "" }),
    ];
    expect(imageFilesFrom({ files } as unknown as DataTransfer).map((f) => f.name)).toEqual(["a.png", "b.JPG"]);
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

function htmlDoc(body: string): Document {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = body;
  return doc;
}

describe("HTML documents", () => {
  it("loads local images through the sidecar but saves the authored link", () => {
    const doc = htmlDoc('<p>Hi</p><img src="pics/a.png" alt="a"><img src="https://x.test/b.png">');
    rewriteHtmlImages(doc, "/d/report.html", PORT);
    rewriteHtmlImages(doc, "/d/report.html", PORT); // idempotent
    const [local, remote] = [...doc.querySelectorAll("img")];
    expect(local.getAttribute("src")).toBe(served("/d/pics/a.png"));
    expect(remote.getAttribute("src")).toBe("https://x.test/b.png");
    const saved = serializeDocument(doc);
    expect(saved).toContain('<img src="pics/a.png" alt="a">');
    expect(saved).not.toContain("127.0.0.1");
    expect(saved).not.toContain("data-had-src");
    // Serializing works on a copy: the live document still shows the image.
    expect(local.getAttribute("src")).toBe(served("/d/pics/a.png"));
  });

  function setup(doc: Document, over: Partial<DocImagesDeps> = {}) {
    const saveImage = vi.fn(async (p: { name: string }) => ({ relPath: `.docuzen/report.html.had/assets/${p.name}`, name: p.name }));
    const readImage = vi.fn(async () => ({ mime: "image/png", dataBase64: "AQID" }));
    const onHtmlEdited = vi.fn();
    const notify = vi.fn();
    const mode = { editable: true };
    const log: string[] = [];
    const api = initDocImages({
      rootEl: document.createElement("div"),
      log: (l) => void log.push(l),
      reportError: (scope, e) => void log.push(`${scope}: ${String(e)}`),
      getEditor: () => undefined,
      getHtmlSurface: () => ({ doc, get isEditable() { return mode.editable; } }) as never,
      notify,
      getDocPath: () => "/d/report.html",
      getFormat: () => "html",
      port: () => PORT,
      saveImage,
      readImage,
      onHtmlEdited,
      ...over,
    });
    api.wireHtmlDocument(doc);
    return { api, saveImage, readImage, onHtmlEdited, notify, mode, log };
  }

  function fire(doc: Document, type: string, key: "dataTransfer" | "clipboardData", data: unknown): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, key, { value: data });
    Object.defineProperty(ev, "clientX", { value: 10 });
    Object.defineProperty(ev, "clientY", { value: 10 });
    doc.body.dispatchEvent(ev);
    return ev;
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("a dropped image is stored, inserted as its own block, and saved as a relative link", async () => {
    const doc = htmlDoc("<h1>Title</h1><p>Body</p>");
    const { saveImage, onHtmlEdited } = setup(doc);
    const file = new File([new Uint8Array([1, 2, 3])], "shot one.png", { type: "image/png" });
    const ev = fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [file] });
    expect(ev.defaultPrevented).toBe(true);
    await settle();

    expect(saveImage).toHaveBeenCalledWith({ name: "shot one.png", dataBase64: "AQID" });
    const img = doc.querySelector("p > img")!;
    expect(img.getAttribute("src")).toBe(served("/d/.docuzen/report.html.had/assets/shot one.png"));
    expect(img.getAttribute("alt")).toBe("shot one");
    expect(onHtmlEdited).toHaveBeenCalled();
    expect(serializeDocument(doc)).toContain('src=".docuzen/report.html.had/assets/shot one.png"');
  });

  it("an image dropped onto an image, a diagram, an inline element or a docuzen card lands beside it, never inside it", async () => {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const cases: { body: string; hit: (doc: Document) => Element; parent: string; next: string }[] = [
      { body: '<div id="box"><img id="pic" src="https://x.test/a.png"></div>', hit: (d) => d.getElementById("pic")!, parent: "box", next: "pic" },
      { body: '<div id="box"><video id="vid"></video></div>', hit: (d) => d.getElementById("vid")!, parent: "box", next: "vid" },
      {
        body: '<div id="box"></div>',
        hit: (d) => {
          const svg = d.createElementNS(SVG_NS, "svg");
          svg.id = "svg";
          const rect = d.createElementNS(SVG_NS, "rect");
          svg.appendChild(rect);
          d.getElementById("box")!.appendChild(svg);
          return rect;
        },
        parent: "box",
        next: "svg",
      },
      {
        // A diagram's HTML label (mermaid draws labels as HTML in a foreignObject).
        body: '<div id="box"></div>',
        hit: (d) => {
          const svg = d.createElementNS(SVG_NS, "svg");
          svg.id = "svg";
          const fo = d.createElementNS(SVG_NS, "foreignObject");
          const label = d.createElement("p");
          label.textContent = "Start";
          fo.appendChild(label);
          svg.appendChild(fo);
          d.getElementById("box")!.appendChild(svg);
          return label;
        },
        parent: "box",
        next: "svg",
      },
      { body: '<span id="s">loose text</span>', hit: (d) => d.getElementById("s")!, parent: "", next: "s" },
      { body: '<div id="card" data-had-overlay=""><p id="cp">Proposed text</p></div>', hit: (d) => d.getElementById("cp")!, parent: "", next: "card" },
    ];
    for (const c of cases) {
      const doc = htmlDoc(c.body);
      const target = c.hit(doc);
      doc.elementFromPoint = () => target;
      setup(doc);
      fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] });
      await settle();
      const added = doc.querySelector('img[alt="a"]')!;
      expect(added, c.body).not.toBeNull();
      const block = added.parentElement!;
      expect(block.parentElement!.id, c.body).toBe(c.parent); // "" is the body
      // Dropped on the lower half of the target (a zero-size box here): it goes right after it.
      expect(block.previousElementSibling?.id, c.body).toBe(c.next);
      expect(serializeDocument(doc), c.body).toContain('src=".docuzen/report.html.had/assets/a.png"');
    }
  });

  it("review mode takes no images by drop, paste or picker: nothing is stored, the user is told to click Edit", async () => {
    const doc = htmlDoc("<h1>Title</h1><p>Body</p>");
    const { api, saveImage, onHtmlEdited, notify, mode } = setup(doc);
    mode.editable = false;
    const before = doc.body.innerHTML;
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const drop = fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [file] });
    const paste = fire(doc, "paste", "clipboardData", { types: ["Files"], files: [file] });
    await api.addPaths(["/p/photo.jpg"]);
    await settle();
    expect(drop.defaultPrevented).toBe(true); // still must not navigate the window to the file
    expect(paste.defaultPrevented).toBe(true);
    expect(saveImage).not.toHaveBeenCalled();
    expect(onHtmlEdited).not.toHaveBeenCalled();
    expect(doc.body.innerHTML).toBe(before);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[0][0]).toMatch(/review mode.*Edit/);
    expect(api.canInsert()).toBe(false);
    mode.editable = true;
    expect(api.canInsert()).toBe(true);
  });

  it("does not insert if Edit is switched off while the image is being stored", async () => {
    const doc = htmlDoc("<p>Body</p>");
    const { mode } = setup(doc);
    fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] });
    mode.editable = false;
    await settle();
    expect(doc.querySelector("img")).toBeNull();
  });

  it("a non-image drop is refused without navigating away", async () => {
    const doc = htmlDoc("<p>Body</p>");
    const { saveImage, log } = setup(doc);
    const ev = fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [new File(["x"], "notes.txt", { type: "text/plain" })] });
    await settle();
    expect(ev.defaultPrevented).toBe(true);
    expect(saveImage).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("only image files");
  });

  it("a pasted screenshot is inserted; pasted text with a preview image is left to the editor", async () => {
    const doc = htmlDoc("<p>Body</p>");
    const { saveImage } = setup(doc);
    const shot = new File([new Uint8Array([9])], "image.png", { type: "image/png" });
    const text = fire(doc, "paste", "clipboardData", { types: ["text/plain", "Files"], files: [shot] });
    expect(text.defaultPrevented).toBe(false);
    const ev = fire(doc, "paste", "clipboardData", { types: ["Files"], files: [shot] });
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(saveImage.mock.calls[0][0].name).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
    expect(doc.querySelectorAll("img").length).toBe(1);
  });

  it("does not insert into a different document than the one dropped on", async () => {
    const doc = htmlDoc("<p>Body</p>");
    let path = "/d/report.html";
    const { log } = setup(doc, { getDocPath: () => path });
    fire(doc, "drop", "dataTransfer", { types: ["Files"], files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] });
    path = "/d/other.html"; // the user switched tabs while the image was being stored
    await settle();
    expect(doc.querySelector("img")).toBeNull();
    expect(log.join("\n")).toContain("document changed");
  });

  it("falls back to reading the image over RPC when the HTTP load fails, and still saves the authored link", async () => {
    const doc = htmlDoc('<img src="pics/a.png">');
    const { readImage } = setup(doc);
    const img = doc.querySelector("img")!;
    img.dispatchEvent(new Event("error"));
    await settle();
    expect(readImage).toHaveBeenCalledWith("/d/pics/a.png");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AQID");
    img.dispatchEvent(new Event("error")); // a data URL that fails is not retried
    await settle();
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(serializeDocument(doc)).toContain('<img src="pics/a.png">');
  });

  it("images picked from disk go in by path", async () => {
    const doc = htmlDoc("<p>Body</p>");
    const { api, saveImage } = setup(doc);
    await api.addPaths(["/Users/me/Desktop/photo.jpg"]);
    expect(saveImage).toHaveBeenCalledWith({ name: "photo.jpg", sourcePath: "/Users/me/Desktop/photo.jpg" });
    expect(doc.querySelectorAll("img").length).toBe(1);
  });
});

describe("markdown image view", () => {
  type ViewFactory = () => (node: unknown) => { dom: HTMLImageElement; update: (node: unknown) => boolean };
  const imageType = { name: "image" };
  const node = (src: string) => ({ type: imageType, attrs: { src, alt: "", title: "" } });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("keeps the RPC fallback when the editor re-renders the node, and retries when the link changes", async () => {
    const resolve = (src: string) => resolveImageSrc("/d/plan.md", src, PORT);
    const read = vi.fn(async () => ({ mime: "image/png", dataBase64: "AQID" }));
    const view = (makeImageView(resolve, read) as unknown as ViewFactory)()(node("pics/a.png"));
    const img = view.dom;
    expect(img.getAttribute("src")).toBe(served("/d/pics/a.png"));

    img.dispatchEvent(new Event("error")); // the webview could not load it over HTTP
    await settle();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AQID");

    // Typing elsewhere re-renders the node with the same link: the image must stay shown.
    expect(view.update(node("pics/a.png"))).toBe(true);
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AQID");

    // A different link is loaded, and gets its own fallback if it fails too.
    view.update(node("pics/b.png"));
    expect(img.getAttribute("src")).toBe(served("/d/pics/b.png"));
    img.dispatchEvent(new Event("error"));
    await settle();
    expect(read).toHaveBeenLastCalledWith("/d/pics/b.png");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AQID");
  });
});

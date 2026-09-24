// @vitest-environment jsdom
// EPUB 解析在 webview 里跑（DOMParser），测试用 jsdom 提供同实现。
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractXhtmlText, parseEpub } from "./bookImport";

/** 生成 .epub 的字节流（EPUB3 NAV 目录版）。 */
async function buildEpub(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

function epubFile(bytes: Uint8Array, name = "book.epub"): File {
  return new File([bytes as BlobPart], name, { type: "application/epub+zip" });
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(spine: string[], manifestItems: string, extra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Call of the Wild</dc:title>
    <dc:creator>Jack London</dc:creator>
    ${extra}
  </metadata>
  <manifest>${manifestItems}</manifest>
  <spine>${spine.map((id) => `<itemref idref="${id}"/>`).join("")}</spine>
</package>`;
}

const XHTML = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;

describe("extractXhtmlText", () => {
  it("块元素切段落、行内折叠空白、br 折空格、跳过 script/style", () => {
    const text = extractXhtmlText(
      XHTML(`<p>Buck did not read the  newspapers.</p>
             <script>evil()</script><style>.x{}</style>
             <p>He had<span>  no </span>need<br/>to fight.</p>
             <div><h2>Chapter II</h2><p>Into the primitive.</p></div>`),
    );
    expect(text).toBe(
      "Buck did not read the newspapers.\n\nHe had no need to fight.\n\nChapter II\n\nInto the primitive.",
    );
  });

  it("非法 XML 回退 HTML 解析", () => {
    const text = extractXhtmlText("<html><body><p>Loose<br>markup</p></body></html>");
    expect(text).toBe("Loose markup");
  });

  it("空文档返回空串", () => {
    expect(extractXhtmlText(XHTML(""))).toBe("");
  });
});

describe("parseEpub", () => {
  const ch1 = XHTML(`<p>Old longings nomadic leap.</p><p>Chafing at custom's chain.</p>`);
  const ch2 = XHTML(`<p>Buck did not read the newspapers.</p><p>He did not know that trouble was coming.</p>`);

  const epub3Files = {
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": opf(
      ["ch1", "ch2"],
      `<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
       <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
       <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ),
    "OEBPS/ch1.xhtml": ch1,
    "OEBPS/ch2.xhtml": ch2,
    "OEBPS/nav.xhtml": `<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <body><nav epub:type="toc"><ol>
          <li><a href="ch1.xhtml">Into the Primitive</a></li>
          <li><a href="ch2.xhtml">The Law of Club and Fang</a></li>
        </ol></nav></body></html>`,
  };

  it("EPUB3 NAV 目录：分章、书名作者、词数与估时", async () => {
    const book = await parseEpub(epubFile(await buildEpub(epub3Files)));
    expect(book.title).toBe("The Call of the Wild");
    expect(book.author).toBe("Jack London");
    expect(book.tocUsed).toBe(true);
    expect(book.chapters.map((c) => c.title)).toEqual(["Into the Primitive", "The Law of Club and Fang"]);
    expect(book.chapters[0].text).toContain("Old longings nomadic leap.");
    expect(book.chapters[1].text).toContain("trouble was coming");
    expect(book.totalWords).toBeGreaterThan(0);
    expect(book.minutes).toBeGreaterThanOrEqual(1);
  });

  it("EPUB2 NCX 目录也能分章", async () => {
    const files = {
      "META-INF/container.xml": CONTAINER,
      "OEBPS/content.opf": opf(
        ["ch1", "ch2"],
        `<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
         <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
        `<meta name="cover" content="cover-img"/>`,
      ),
      "OEBPS/ch1.xhtml": ch1,
      "OEBPS/ch2.xhtml": ch2,
      "OEBPS/toc.ncx": `<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head/><docTitle><text>x</text></docTitle>
          <navMap>
            <navPoint id="n1" playOrder="1"><navLabel><text>卷一 · 第一章</text></navLabel><content src="ch1.xhtml"/></navPoint>
            <navPoint id="n2" playOrder="2"><navLabel><text>第二章</text></navLabel><content src="ch2.xhtml"/></navPoint>
          </navMap>
        </ncx>`,
    };
    const book = await parseEpub(epubFile(await buildEpub(files)));
    expect(book.tocUsed).toBe(true);
    expect(book.chapters.map((c) => c.title)).toEqual(["卷一 · 第一章", "第二章"]);
  });

  it("多 HTML 拼一章：一个 toc 条目覆盖到下一条目之前的全部 spine 文件", async () => {
    const files = {
      "META-INF/container.xml": CONTAINER,
      "OEBPS/content.opf": opf(
        ["p1", "p2", "p3"],
        `<item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
         <item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/>
         <item id="p3" href="p3.xhtml" media-type="application/xhtml+xml"/>
         <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      ),
      "OEBPS/p1.xhtml": XHTML(`<p>Part one first half.</p>`),
      "OEBPS/p2.xhtml": XHTML(`<p>Part one second half continues here.</p>`),
      "OEBPS/p3.xhtml": XHTML(`<p>A brand new chapter begins.</p>`),
      "OEBPS/nav.xhtml": `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol>
            <li><a href="p1.xhtml">Merged Chapter</a></li>
            <li><a href="p3.xhtml">Next</a></li>
          </ol></nav></body></html>`,
    };
    const book = await parseEpub(epubFile(await buildEpub(files)));
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].text).toContain("second half");
    expect(book.chapters[0].title).toBe("Merged Chapter");
  });

  it("无目录：按 ~每节词数回退分节并明示", async () => {
    const paras = Array.from({ length: 400 }, (_, i) => `<p>Sentence number ${i} tells a wordy story of travel.</p>`).join("");
    const files = {
      "META-INF/container.xml": CONTAINER,
      "OEBPS/content.opf": opf(
        ["c1", "c2"],
        `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>`,
      ),
      "OEBPS/c1.xhtml": XHTML(paras),
      "OEBPS/c2.xhtml": XHTML(paras),
    };
    const book = await parseEpub(epubFile(await buildEpub(files)));
    expect(book.tocUsed).toBe(false);
    expect(book.fallbackNotice).toContain("未识别到目录");
    expect(book.chapters.length).toBeGreaterThanOrEqual(2);
    expect(book.chapters[0].title).toBe("第 1 节");
  });

  it("目录可疑（实质文件大量未被引用）：回退分节", async () => {
    const filler = (seed: string) =>
      XHTML(
        Array.from({ length: 8 }, (_, i) => `<p>${seed} paragraph ${i} wanders through the valley with plenty of words to fill the length threshold required here.</p>`).join(""),
      );
    const files = {
      "META-INF/container.xml": CONTAINER,
      "OEBPS/content.opf": opf(
        ["c1", "c2", "c3"],
        `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
         <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
         <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      ),
      "OEBPS/c1.xhtml": filler("Alpha chapter"),
      "OEBPS/c2.xhtml": filler("Orphan beta"),
      "OEBPS/c3.xhtml": filler("Orphan gamma"),
      "OEBPS/nav.xhtml": `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Only One</a></li></ol></nav></body></html>`,
    };
    const book = await parseEpub(epubFile(await buildEpub(files)));
    expect(book.tocUsed).toBe(false);
    expect(book.fallbackNotice).toContain("目录不完整");
    // 内容不丢：回退分节覆盖全部三个文件。
    const all = book.chapters.map((c) => c.text).join("\n");
    expect(all).toContain("Orphan beta");
    expect(all).toContain("Orphan gamma");
  });

  it("DRM（加密了 XHTML）→ 拒绝并给出中文原因", async () => {
    const files = {
      ...epub3Files,
      "META-INF/encryption.xml": `<?xml version="1.0"?>
        <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData>
        </encryption>`,
    };
    await expect(parseEpub(epubFile(await buildEpub(files)))).rejects.toThrow("DRM");
  });

  it("只混淆字体的 encryption.xml 不算 DRM，正常解析", async () => {
    const files = {
      ...epub3Files,
      "META-INF/encryption.xml": `<?xml version="1.0"?>
        <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/x.otf"/></enc:CipherData></enc:EncryptedData>
        </encryption>`,
    };
    const book = await parseEpub(epubFile(await buildEpub(files)));
    expect(book.chapters).toHaveLength(2);
  });

  it("非 .epub 扩展名拒绝", async () => {
    await expect(parseEpub(epubFile(await buildEpub(epub3Files), "book.mobi"))).rejects.toThrow("仅支持 .epub");
  });

  it("损坏的 zip 拒绝", async () => {
    const bad = new File([new Uint8Array([1, 2, 3, 4, 5])], "broken.epub");
    await expect(parseEpub(bad)).rejects.toThrow("EPUB 解析失败");
  });

  it("正文为空（纯图片书）拒绝且不产出空书", async () => {
    const files = {
      "META-INF/container.xml": CONTAINER,
      "OEBPS/content.opf": opf(
        ["c1"],
        `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>`,
      ),
      "OEBPS/c1.xhtml": XHTML(`<div><img src="a.png"/></div>`),
    };
    await expect(parseEpub(epubFile(await buildEpub(files)))).rejects.toThrow("抽不到正文");
  });

  it("封面可提取为 dataURL（meta name=cover）", async () => {
    const zip = new JSZip();
    zip.file("META-INF/container.xml", CONTAINER);
    zip.file(
      "OEBPS/content.opf",
      opf(
        ["ch1"],
        `<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>`,
        `<meta name="cover" content="cover-img"/>`,
      ),
    );
    zip.file("OEBPS/ch1.xhtml", ch1);
    // 1x1 JPEG。
    zip.file("OEBPS/cover.jpg", new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const book = await parseEpub(epubFile(bytes));
    expect(book.coverDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });
});

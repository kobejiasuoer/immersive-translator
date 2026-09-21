/**
 * pdfjs-dist 的 legacy build 没有独立类型入口（types 只挂在包根），
 * 与标准 build 同源，这里复用根类型供单测导入。
 */
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}

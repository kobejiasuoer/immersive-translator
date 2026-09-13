/**
 * 网页正文抓取（内容进水口 · 网页链接导入）。
 * Rust 端 reader_fetch_url 完成：下载 → 剥导航/广告/脚本 → 抽正文与标题。
 * 失败（付费墙/需要登录/内容过少）时 reject，message 面向用户可直接展示。
 */

import { invoke } from "@tauri-apps/api/core";

export interface FetchedArticle {
  /** 清洗后的最终 URL（跟随重定向后）。 */
  url: string;
  /** 站点域名（预览卡展示）。 */
  host: string;
  /** 文章标题（og:title / <title> 清洗后）。 */
  title: string;
  /** 正文纯文本，段落以空行分隔。 */
  text: string;
}

export function readerFetchUrl(url: string): Promise<FetchedArticle> {
  return invoke<FetchedArticle>("reader_fetch_url", { url });
}

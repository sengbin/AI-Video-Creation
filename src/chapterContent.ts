/*
------------------------------------------------------------------------
名称：chapterContent.ts
说明：定义章节创作内容的数据结构及数量上限。
作者：Lion
邮箱：chengbin@3578.cn
日期：2026-09-28
备注：无
------------------------------------------------------------------------
*/

export const MAX_GENERATED_CHAPTERS = 100;
export const MIN_CHAPTER_WORDS = 100;

/** 一章创作结果的章节号、标题和正文。 */
export interface GeneratedChapterContent {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
}

/** 按汉字数和英文/数字词数统计正文，忽略标题、空格和标点。 */
export function countChapterWords(content: string): number {
  return content.match(/[\p{Script=Han}]|[A-Za-z0-9]+/gu)?.length ?? 0;
}
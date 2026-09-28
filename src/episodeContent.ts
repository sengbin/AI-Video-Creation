/*
------------------------------------------------------------------------
名称：episodeContent.ts
说明：定义分集创作内容的数据结构及数量上限。
作者：Lion
邮箱：chengbin@3578.cn
日期：2026-09-28
备注：无
------------------------------------------------------------------------
*/

export const MAX_GENERATED_EPISODES = 100;

/** 一集创作结果的集数、标题和正文。 */
export interface GeneratedEpisodeContent {
  readonly episodeNumber: number;
  readonly title: string;
  readonly content: string;
}
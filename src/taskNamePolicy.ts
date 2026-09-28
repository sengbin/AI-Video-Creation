/*
------------------------------------------------------------------------
名称：taskNamePolicy.ts
说明：集中定义任务名称需要全局唯一的内容创作工作流。
作者：Lion
邮箱：chengbin@3578.cn
日期：2026-09-29
备注：无
------------------------------------------------------------------------
*/

export const CREATIVE_WRITING_WORKFLOW_NAME = 'ai-video-creation-tools_collect_creative_writing_parameters';
export const IMAGE_INSPIRED_WRITING_WORKFLOW_NAME = 'ai-video-creation-tools_collect_image_inspired_writing_parameters';
export const NOVEL_RECREATION_WORKFLOW_NAME = 'ai-video-creation-tools_collect_novel_parameters';
export const UNIQUE_CONTENT_TASK_WORKFLOW_NAMES = [
  CREATIVE_WRITING_WORKFLOW_NAME,
  IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
  NOVEL_RECREATION_WORKFLOW_NAME
] as const;
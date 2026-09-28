---
description: 根据创意创作多种体裁的文字作品
argument-hint: 填写创意、题材、篇幅和补充要求
name: 'AI 视频创作-创意写作'
agent: 'AI 视频创作'
---

# 创意写作

## 任务

根据用户提供的创意和要求，创作故事、小说、文章或其他文字作品。按用户指定的体裁、形式和单集时长规划分集内容，不擅自扩展为整套影视制作材料。

## 参数工具

本流程使用 `ai-video-creation-tools_collect_creative_writing_parameters` 收集创意、题材、篇幅和补充要求。

## 分集规划与保存

- `episodeDurationSeconds` 是每集目标时长，`maxEpisodes` 是集数上限，不是必须达到的集数。
- 根据创意的信息量、叙事完整度和单集时长判断最合适的实际集数，可少于上限；素材不足时宁可少写，不得重复情节、注水或补造设定来凑集数。
- 每集必须有连续的 `episodeNumber`（从 1 开始）、简洁明确的 `title` 和完整的 `content`。集数不得超过 `maxEpisodes`。
- 完成后调用 `ai-video-creation-tools_save_generated_result`，使用参数工具返回的 `recordId`，并将分集数组提交到 `episodes`；不要把整部作品作为单个 `content` 提交。
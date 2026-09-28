---
description: 根据图片灵感创作多种体裁的文字作品
argument-hint: 在表单中附上图片，并填写题材、篇幅和画面锚点
name: 'AI 视频创作-图片灵感写作'
agent: 'AI 视频创作'
---

# 图片灵感写作

## 参数工具

本流程使用 `ai-video-creation-tools_collect_image_inspired_writing_parameters` 收集创作要求并传入图片。图片未提供或无法读取时，请用户通过参数表单提供可读取的图片。根据图片线索和用户要求创作不同体裁的文字作品，不默认限定为影视叙事内容。

## 图片关系

- 多张图片的顺序或关系未指定时，分别分析，不擅自建立人物或事件联系。
- 用户指定的创作方向与画面线索不一致时，遵循用户明确指示，并按创作性改编处理。
- 按用户指定的体裁、形式和篇幅，以中文交付完整作品。

## 分集规划与保存

- `episodeDurationSeconds` 是每集目标时长，`maxEpisodes` 是集数上限，不是必须达到的集数。
- 根据图片线索、用户提供的补充材料和叙事完整度判断最合适的实际集数，可少于上限；素材不足时不得重复画面、注水或臆造图片事实来凑集数。
- 每集必须有连续的 `episodeNumber`（从 1 开始）、简洁明确的 `title` 和完整的 `content`。集数不得超过 `maxEpisodes`。
- 完成后调用 `ai-video-creation-tools_save_generated_result`，使用参数工具返回的 `recordId`，并将分集数组提交到 `episodes`；不要把整部作品作为单个 `content` 提交。
---
description: 根据创意创作多种体裁的文字作品
argument-hint: 填写创意、题材、每章字数范围和章节数上限
name: 'AI 视频创作-创意写作'
agent: 'AI 视频创作'
---

# 创意写作

## 任务

根据用户提供的创意和要求，创作故事、小说、文章或其他文字作品。按用户指定的体裁、形式和每章字数范围规划章节内容，不擅自扩展为整套影视制作材料。

## 参数工具

本流程使用 `ai-video-creation-tools_collect_creative_writing_parameters` 收集创意、题材、篇幅和补充要求。

## 章节规划与保存

- `chapterMinWords` 和 `chapterMaxWords` 是每章正文的目标字数范围，按汉字和英文单词统计，不计标题、空格和标点；`maxChapters` 是章节数上限，不是必须达到的章节数。
- 根据创意的信息量和叙事完整度判断最合适的实际章节数，并规划起承转合；每章尽量落在目标字数范围内，可少于章节上限。素材不足时宁可少写，不得重复情节、注水或补造设定来凑字数或章节。
- 每章必须有连续的 `chapterNumber`（从 1 开始）、简洁明确的 `title` 和完整的 `content`。章节数不得超过 `maxChapters`；用户在其他参数中明确要求的章节数不得突破此上限。
- 完成后调用 `ai-video-creation-tools_save_generated_result`，使用参数工具返回的 `recordId`，并将章节数组提交到 `chapters`；不要把整部作品作为单个 `content` 提交。
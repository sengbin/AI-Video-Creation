# AI 视频创作工具

面向 AI 视频创作流程的 Visual Studio Code 扩展。扩展提供九个创作 Prompt、AI 视频创作 Agent 和通用生成提示词 Skill。故事、剧本和拍摄脚本任务用于整理可交给下游文本或视频模型的提示词；角色、场景、道具和特效任务用于整理图像或视频生成提示词。

运行 Prompt 后，Copilot 会调用对应参数表单；表单提交内容用于组织本次生成提示词。提示词默认采用适合目标产物的结构，包含必要的输入、生成要求、交付格式和限制。生成结果仍需由目标 AI 模型执行，实际输出受模型能力影响。

图片和小说原作仍需要作为 Copilot 聊天附件或消息内容提供，不通过扩展表单上传。

## 开发

需要安装 Node.js 和 npm。

```powershell
npm install
npm run compile
npm test
```

在 VS Code 中打开本目录，按 `F5` 启动扩展开发宿主。运行 `npm test` 验证扩展和资源注册。

## 使用

1. 安装扩展并打开 Visual Studio Code。
2. 在 Copilot Chat 中选择任一扩展提供的视频创作 Prompt。故事、剧本和拍摄脚本 Prompt 会生成供下游模型使用的指令，不会直接生成最终故事或成片。
3. 允许对应的参数收集工具运行，在表单中填写任意字段或留空，然后选择“确定并继续”。
4. 如使用图片写故事或小说改编，先将图片或原作附加到同一聊天。复制生成的下游提示词时，也要按提示词要求一并提供所需的图片、原作或剧本素材。

工具调用需要当前 VS Code Agent 和所选模型支持扩展工具调用。工具权限由 VS Code 管理，首次调用时可能需要批准。

扩展技能依赖 VS Code Agent Skills 支持；VS Code 1.108 首次提供该能力且当时需要启用 `chat.useAgentSkills`。建议使用较新的 VS Code 版本。

## 打包与发布

1. 将 `package.json` 中的 `publisher` 替换为已在 Visual Studio Marketplace 注册的发布者 ID。
2. 根据实际发布授权添加许可证文件，并在 `package.json` 中填写对应许可证标识。
3. 根据发布信息补充扩展图标。
4. 运行 `npm run package` 生成 `.vsix` 安装包。
5. 按照 [发布扩展指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) 登录发布者账号并发布。
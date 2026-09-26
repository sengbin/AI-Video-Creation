import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { PromptDatabase } from '../../database';
import { formWorkflows } from '../../formWorkflows';

suite('AI 视频创作工具扩展', () => {
  test('首次打开时创建用户级数据库并保存动态模板记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-db-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    let database = await PromptDatabase.open(vscode.Uri.file(storagePath));

    try {
      const record = database.saveRecord({
        categoryId: 'ai-video-creation-tools_collect_story_parameters',
        categoryName: '创意写故事',
        schema: [{ id: 'genre', label: '题材', type: 'text' }],
        data: { genre: '科幻' }
      });

      assert.ok(fs.existsSync(path.join(storagePath, 'prompt-records.sqlite')));
      assert.deepStrictEqual(database.getRecord(record.id), record);
      assert.deepStrictEqual(
        database.listRecords('ai-video-creation-tools_collect_story_parameters'),
        [record]
      );
      assert.deepStrictEqual(
        database.listRecords('ai-video-creation-tools_collect_novel_parameters'),
        []
      );

      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(storagePath));
      assert.deepStrictEqual(database.getRecord(record.id), record);
      assert.strictEqual(database.deleteRecord(record.id), true);
      assert.strictEqual(database.getRecord(record.id), undefined);
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够激活扩展并注册九个参数表单工具', async () => {
    const extension = vscode.extensions.getExtension('chengbin.ai-video-creation-tools');

    if (!extension) {
      throw new Error('未找到 AI 视频创作工具扩展。');
    }

    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    const registeredTools = vscode.lm.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('ai-video-creation-tools_collect_'))
      .sort();

    assert.deepStrictEqual(registeredTools, [
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_effect_parameters',
      'ai-video-creation-tools_collect_image_story_parameters',
      'ai-video-creation-tools_collect_novel_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_screenplay_parameters',
      'ai-video-creation-tools_collect_shooting_script_parameters',
      'ai-video-creation-tools_collect_story_parameters'
    ]);

    const contributions = extension.packageJSON.contributes;
    assert.strictEqual(contributions.chatAgents.length, 1);
    assert.strictEqual(contributions.chatSkills.length, 1);
    assert.strictEqual(contributions.chatPromptFiles.length, 9);
    const extensionRoot = extension.extensionUri.fsPath;
    const contributedPaths = [
      ...contributions.chatAgents,
      ...contributions.chatSkills,
      ...contributions.chatPromptFiles
    ];

    for (const contribution of contributedPaths) {
      assert.ok(fs.existsSync(path.join(extensionRoot, contribution.path)));
      assert.strictEqual('name' in contribution, false);
      assert.strictEqual('description' in contribution, false);
    }

    const imagePromptWorkflows = [
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_effect_parameters'
    ];

    for (const toolName of imagePromptWorkflows) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.ok(!workflow.fields.some((field) => field.name === 'task'));
    }

    const expectedFieldNames: Readonly<Record<string, readonly string[]>> = {
      'ai-video-creation-tools_collect_story_parameters': [
        'idea', 'genre', 'duration', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_image_story_parameters': [
        'genre', 'duration', 'visualElements', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_novel_parameters': [
        'target', 'scope', 'preserve', 'adjustments', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_screenplay_parameters': [
        'sourceMaterial', 'format', 'genre', 'duration', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_shooting_script_parameters': [
        'scriptSource', 'duration', 'aspectRatio', 'visualStyle', 'cameraStyle', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_character_parameters': [
        'characterType', 'appearance', 'clothing', 'expressionPose', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_scene_parameters': [
        'placeType', 'layout', 'environment', 'composition', 'style', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_prop_parameters': [
        'propName', 'appearance', 'state', 'composition', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_effect_parameters': [
        'source', 'appearance', 'motion', 'environmentInteraction', 'composition', 'style', 'additionalInfo'
      ]
    };

    for (const [toolName, fieldNames] of Object.entries(expectedFieldNames)) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.deepStrictEqual(workflow.fields.map((field) => field.name), fieldNames);
      assert.ok(workflow.fields.some((field) => field.name === 'additionalInfo'));
    }

    const characterWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_character_parameters');
    assert.ok(characterWorkflow);
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'characterType')?.options,
      ['人类', '动物', '怪物', '丧尸', '其他']
    );
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'composition')?.options,
      ['正面全身像', '三视图（正面、侧面、背面）', '正面半身像', '侧面全身像', '面部特写']
    );
    assert.strictEqual(characterWorkflow.fields.find((field) => field.name === 'composition')?.allowCustom, true);
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'style')?.options,
      ['写实电影风格', '写实摄影', '2D动漫插画', '3D动画风格', '游戏概念设计', '水彩插画', '黑白线稿']
    );
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'background')?.options,
      ['纯白背景', '浅灰纯色背景', '纯色背景', '简洁渐变背景', '与角色设定相符的环境背景']
    );

    const shootingScriptWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_shooting_script_parameters');
    assert.ok(shootingScriptWorkflow);
    assert.deepStrictEqual(
      shootingScriptWorkflow.fields.find((field) => field.name === 'visualStyle')?.options,
      ['写实电影风格', '写实摄影', '2D动漫插画', '3D动画风格', '游戏概念设计', '水彩插画', '黑白线稿']
    );
    assert.deepStrictEqual(
      shootingScriptWorkflow.fields.find((field) => field.name === 'cameraStyle')?.options,
      ['固定机位（稳定中近景）', '缓慢推近', '缓慢拉远', '横向摇摄', '跟随移动镜头', '手持纪实感', '低机位仰拍', '俯拍全景', '浅景深特写']
    );
    assert.strictEqual(shootingScriptWorkflow.fields.find((field) => field.name === 'cameraStyle')?.allowCustom, true);

    const customizableFields = formWorkflows.flatMap((workflow) => workflow.fields)
      .filter((field) => field.allowCustom);
    assert.ok(customizableFields.length > 0);
    assert.ok(customizableFields.every((field) => Boolean(field.options)));

    assert.ok(formWorkflows.every((workflow) => workflow.fields
      .filter((field) => !field.options)
      .every((field) => Boolean(field.placeholder))));

    const agentPath = path.join(extensionRoot, contributions.chatAgents[0].path);
    const agentContent = fs.readFileSync(agentPath, 'utf8');
    const agentFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentContent);
    assert.ok(agentFrontmatter);
    const agentMetadata = parseYaml(agentFrontmatter[1]);
    assert.strictEqual(agentMetadata.name, 'AI 视频创作（扩展）智能体');
    assert.ok(agentMetadata.description);
    assert.ok(agentContent.includes('如果当前会话未加载该 Skill 或无法使用其规则，立即停止；不得调用参数表单工具或继续生成'));

    const skillPath = path.join(extensionRoot, contributions.chatSkills[0].path);
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const skillFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillContent);
    assert.ok(skillFrontmatter);
    const skillMetadata = parseYaml(skillFrontmatter[1]);
    assert.strictEqual(skillMetadata.name, 'ai-video-prompt-design');
    assert.strictEqual(path.basename(path.dirname(skillPath)), skillMetadata.name);
    assert.ok(skillMetadata.description);
    assert.ok(skillContent.includes('拍摄脚本生成提示词结构'));

    const promptTools = [
      ['creative-story.prompt.md', 'ai-video-creation-tools_collect_story_parameters', '## 创作目标'],
      ['image-story.prompt.md', 'ai-video-creation-tools_collect_image_story_parameters', '## 看图提示词设计流程'],
      ['novel-adaptation.prompt.md', 'ai-video-creation-tools_collect_novel_parameters', '## 改编提示词设计流程'],
      ['screenplay.prompt.md', 'ai-video-creation-tools_collect_screenplay_parameters', '## 剧本提示词设计流程'],
      ['shooting-script.prompt.md', 'ai-video-creation-tools_collect_shooting_script_parameters', '## 拍摄提示词设计流程'],
      ['character-generation.prompt.md', 'ai-video-creation-tools_collect_character_parameters', '## 角色设定流程'],
      ['scene-generation.prompt.md', 'ai-video-creation-tools_collect_scene_parameters', '## 场景设定流程'],
      ['prop-generation.prompt.md', 'ai-video-creation-tools_collect_prop_parameters', '## 道具设定流程'],
      ['effect-generation.prompt.md', 'ai-video-creation-tools_collect_effect_parameters', '## 特效设定流程']
    ];

    for (const [promptName, toolName, domainInstructionsHeading] of promptTools) {
      const promptPath = path.join(extensionRoot, 'copilot-customizations', 'prompts', promptName);
      const promptContent = fs.readFileSync(promptPath, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(promptContent);
      assert.ok(frontmatter);
      const metadata = parseYaml(frontmatter[1]);
      assert.ok(metadata.name);
      assert.ok(metadata.description);
      assert.strictEqual(metadata.agent, 'AI 视频创作（扩展）智能体');
      assert.strictEqual(metadata.tools, undefined);
      assert.ok(promptContent.includes(`必须调用一次 \`${toolName}\``));
      assert.ok(promptContent.includes('## 使用范围'));
      assert.ok(promptContent.includes('本 Prompt 用于'));
      assert.ok(promptContent.includes(domainInstructionsHeading));
      assert.ok(!promptContent.includes('ai-video-prompt-design'));
      assert.ok(promptContent.includes('代码块'));
      assert.ok(promptContent.includes('补充要求'));
      if (promptName === 'character-generation.prompt.md') {
        assert.ok(promptContent.includes('角色类型和主体'));
        assert.ok(promptContent.includes('丧尸的腐坏特征'));
      }
    }
  });
});
